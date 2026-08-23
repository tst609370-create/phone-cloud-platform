import { createHash } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { AdbClient, parseSerialFromMdnsName } from '../AdbClient';
import { resolveUserId } from '../auth/currentUser';
import { canAccessDevice, requireDeviceAccess } from '../auth/deviceAccess';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { resolveMac } from '../network/MacResolver';
import { detectSubnet } from '../network/SubnetDetector';
import { assertDeletablePaths, shArg } from '../security/deviceInput';
import { upsertObservedDevices } from './deviceObserved';
import { BodyTooLargeError, InvalidJsonError, readJsonBodyStrict, sendInternalError } from './utils';
import { RealtimeEventsApi } from './RealtimeEventsApi';

const log = Logger.for('DeviceDiscoveryApi');
const INPUT_KEYS: Record<string, number> = { back: 4, home: 3, recent: 187, enter: 66, delete: 67 };
const coordinate = (value: unknown): number | null => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 20_000 ? Math.round(number) : null;
};

const decodeXml = (value: string): string => value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function uiLabelAtPoint(xml: string, x: number, y: number): string | undefined {
    let best: { area: number; label: string } | undefined;
    for (const match of xml.matchAll(/<node\b([^>]*)>/g)) {
        const attrs = match[1] || '';
        const bounds = /bounds="\[(\d+),(\d+)]\[(\d+),(\d+)]"/.exec(attrs);
        if (!bounds) continue;
        const [left, top, right, bottom] = bounds.slice(1).map(Number);
        if (x < left! || x > right! || y < top! || y > bottom!) continue;
        const attribute = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] || '';
        const raw = attribute('content-desc') || attribute('text');
        const label = decodeXml(raw).replace(/[，,]?按钮$/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const area = (right! - left!) * (bottom! - top!);
        if (label && area > 0 && (!best || area < best.area)) best = { area, label };
    }
    return best?.label;
}

type CachedFrame = { capturedAt: number; etag: string; data: Buffer };

export class DeviceDiscoveryApi {
    private adbClient: AdbClient;
    private readonly frameCache = new Map<string, CachedFrame>();
    private readonly frameCaptures = new Map<string, Promise<CachedFrame>>();

    constructor(adbClient?: AdbClient) {
        this.adbClient = adbClient ?? new AdbClient(Config.getInstance().adbPath);
    }

    private async captureFrame(udid: string, force: boolean): Promise<CachedFrame> {
        const cached = this.frameCache.get(udid);
        if (!force && cached && Date.now() - cached.capturedAt < 350) return cached;
        const running = this.frameCaptures.get(udid);
        if (running) return running;
        const capture = this.adbClient.execOut(udid, 'screencap -p').then((data) => {
            if (!data.length) throw new Error('empty screenshot');
            const frame = {
                capturedAt: Date.now(),
                etag: `"${createHash('sha1').update(data).digest('hex')}"`,
                data,
            };
            this.frameCache.set(udid, frame);
            return frame;
        });
        this.frameCaptures.set(udid, capture);
        try {
            return await capture;
        } finally {
            this.frameCaptures.delete(udid);
        }
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/devices')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            if (req.method === 'GET' && url.startsWith('/api/devices/frame')) {
                const parsedUrl = new URL(url, `http://${req.headers.host}`);
                const udid = parsedUrl.searchParams.get('udid');
                if (!udid) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid is required' }));
                    return true;
                }
                if (!requireDeviceAccess(req, res, udid)) return true;
                const frame = await this.captureFrame(udid, parsedUrl.searchParams.get('fresh') === '1');
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('ETag', frame.etag);
                if (req.headers['if-none-match'] === frame.etag) {
                    res.writeHead(304);
                    res.end();
                    return true;
                }
                res.setHeader('Content-Type', 'image/png');
                res.setHeader('Content-Length', String(frame.data.length));
                res.writeHead(200);
                res.end(frame.data);
                return true;
            }

            if (req.method === 'GET' && url.startsWith('/api/devices/element')) {
                const parsedUrl = new URL(url, `http://${req.headers.host}`);
                const udid = parsedUrl.searchParams.get('udid');
                const x = coordinate(parsedUrl.searchParams.get('x'));
                const y = coordinate(parsedUrl.searchParams.get('y'));
                if (!udid || x === null || y === null) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid, x and y are required' }));
                    return true;
                }
                if (!requireDeviceAccess(req, res, udid)) return true;
                const xml = await this.adbClient.shell(
                    udid,
                    'uiautomator dump --compressed /data/local/tmp/phonecloud-window.xml >/dev/null && cat /data/local/tmp/phonecloud-window.xml',
                    8_000,
                );
                res.writeHead(200);
                res.end(JSON.stringify({ label: uiLabelAtPoint(xml, x, y) || null }));
                return true;
            }

            if (req.method === 'POST' && url.startsWith('/api/devices/input')) {
                const inputUrl = new URL(url, `http://${req.headers.host}`);
                if (inputUrl.pathname !== '/api/devices/input') return false;
                const body = await readJsonBodyStrict<{
                    udid?: string;
                    action?: string;
                    x?: number;
                    y?: number;
                    x2?: number;
                    y2?: number;
                    duration?: number;
                    key?: string;
                    text?: string;
                }>(req);
                if (!body.udid || !body.action) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid and action are required' }));
                    return true;
                }
                if (!requireDeviceAccess(req, res, body.udid)) return true;
                let command = '';
                if (body.action === 'tap') {
                    const x = coordinate(body.x);
                    const y = coordinate(body.y);
                    if (x === null || y === null) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'invalid tap coordinates' }));
                        return true;
                    }
                    command = `input tap ${x} ${y}`;
                } else if (body.action === 'swipe') {
                    const x = coordinate(body.x);
                    const y = coordinate(body.y);
                    const x2 = coordinate(body.x2);
                    const y2 = coordinate(body.y2);
                    if ([x, y, x2, y2].some((value) => value === null)) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'invalid swipe coordinates' }));
                        return true;
                    }
                    const duration = Math.max(50, Math.min(1_500, Math.round(Number(body.duration) || 250)));
                    command = `input swipe ${x} ${y} ${x2} ${y2} ${duration}`;
                } else if (body.action === 'key') {
                    const keyevent = body.key ? INPUT_KEYS[body.key] : undefined;
                    if (!keyevent) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'invalid key' }));
                        return true;
                    }
                    command = `input keyevent ${keyevent}`;
                } else if (body.action === 'text') {
                    if (typeof body.text !== 'string' || !body.text || body.text.length > 200) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'invalid text' }));
                        return true;
                    }
                    command = `input text ${shArg(body.text.replace(/ /g, '%s'))}`;
                } else {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'invalid input action' }));
                    return true;
                }
                await this.adbClient.shell(body.udid, command, 8_000);
                if (inputUrl.searchParams.get('frame') === '1') {
                    await new Promise((resolve) => setTimeout(resolve, 120));
                    const runningCapture = this.frameCaptures.get(body.udid);
                    if (runningCapture) await runningCapture.catch(() => undefined);
                    const frame = await this.captureFrame(body.udid, true);
                    res.setHeader('Cache-Control', 'no-store');
                    res.setHeader('ETag', frame.etag);
                    res.setHeader('Content-Type', 'image/png');
                    res.setHeader('Content-Length', String(frame.data.length));
                    res.writeHead(200);
                    res.end(frame.data);
                    return true;
                }
                res.writeHead(204);
                res.end();
                return true;
            }

            if (req.method === 'GET' && url === '/api/devices/connected') {
                const db = Config.getInstance().db;
                const userId = resolveUserId(req);
                const connected = (await this.adbClient.devices()).filter(
                    (device) => device.state === 'device' && canAccessDevice(db, userId, device.serial),
                );
                const devices = await Promise.all(
                    connected.map(async (device) => {
                        try {
                            const props = await this.adbClient.getProperties(device.serial);
                            const characteristics = props['ro.build.characteristics'] || '';
                            return {
                                serial: device.serial,
                                state: device.state,
                                model: props['ro.product.model'] || device.serial,
                                manufacturer: props['ro.product.manufacturer'] || '',
                                deviceKind: characteristics.includes('tablet') ? 'tablet' : 'phone',
                                label: db.devices.getLabel(userId, device.serial) || '',
                            };
                        } catch {
                            return {
                                serial: device.serial,
                                state: device.state,
                                model: device.serial,
                                manufacturer: '',
                                deviceKind: 'phone',
                                label: db.devices.getLabel(userId, device.serial) || '',
                            };
                        }
                    }),
                );
                res.writeHead(200);
                res.end(JSON.stringify(devices));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/scan') {
                if (Config.getInstance().db.users.getById(resolveUserId(req))?.role !== 'admin') {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'admin required' }));
                    return true;
                }
                const discovered = await this.adbClient.mdnsServices();
                const connectable = discovered.filter(
                    (d) => d.service.includes('_adb') && !d.service.includes('pairing'),
                );
                const connected = await this.adbClient.devices();
                const connectedAddresses = new Set(connected.map((d) => d.serial));
                const db = Config.getInstance().db;
                const userId = resolveUserId(req);
                const available = connectable
                    .filter((d) => {
                        const addr = `${d.address}:${d.port}`;
                        return !connectedAddresses.has(addr);
                    })
                    .map((d) => {
                        const serial = parseSerialFromMdnsName(d.name, d.service);
                        // Enrich with the remembered model from a prior observation
                        // (read before the sighting upsert below).
                        const observed = db.devices.getDevice(serial);
                        return {
                            ...d,
                            serial,
                            label: db.devices.getLabel(userId, serial) || '',
                            model: observed?.model ?? null,
                        };
                    });
                // Record this sighting in the shared observed table.
                upsertObservedDevices(
                    db,
                    available.map((d) => ({
                        serial: d.serial,
                        address: `${d.address}:${d.port}`,
                        lastSeenAt: Date.now(),
                    })),
                );
                res.writeHead(200);
                res.end(JSON.stringify(available));
                return true;
            }

            if (req.method === 'GET' && url === '/api/devices/scan/subnet') {
                if (Config.getInstance().db.users.getById(resolveUserId(req))?.role !== 'admin') {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'admin required' }));
                    return true;
                }
                const detected = await detectSubnet();
                res.writeHead(200);
                res.end(JSON.stringify(detected));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/connect') {
                if (Config.getInstance().db.users.getById(resolveUserId(req))?.role !== 'admin') {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'admin required' }));
                    return true;
                }
                const { address, serial, label } = await readJsonBodyStrict<{
                    address?: string;
                    serial?: string;
                    label?: string;
                }>(req);
                if (!address) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address is required' }));
                    return true;
                }
                const db = Config.getInstance().db;
                const userId = resolveUserId(req);
                // mDNS path: serial is known upfront, save the label before connecting.
                if (serial && label) {
                    db.devices.setLabel(userId, serial, label);
                }
                const result = await this.adbClient.connect(address);
                const success = result.includes('connected');
                log.info(`connect ${address} → ${success ? 'OK' : 'FAIL'}: ${result.trim().replace(/\s+/g, ' ')}`);
                if (success && label) {
                    // Persist the label under the device's real serial AND its MAC.
                    // Storing under both keys lets future scans (which may only have
                    // MAC from ARP — no serial without racing adb) still rehydrate
                    // the label. Only applies when the user provided a label on this
                    // connect; otherwise nothing to persist.
                    try {
                        let realSerial = serial;
                        if (!realSerial) {
                            const lookedUp = (await this.adbClient.shell(address, 'getprop ro.serialno')).trim();
                            if (lookedUp) realSerial = lookedUp;
                        }
                        if (realSerial) {
                            db.devices.setLabel(userId, realSerial, label);
                        }
                        const ip = address.split(':')[0]!;
                        const mac = await resolveMac(ip);
                        if (mac) {
                            db.devices.setLabel(userId, mac, label);
                        }
                    } catch {
                        // Serial or MAC lookup failed — partial persist is OK;
                        // user can edit label later from the card.
                    }
                }
                res.writeHead(success ? 200 : 500);
                res.end(JSON.stringify({ success, message: result.trim() }));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/disconnect') {
                if (Config.getInstance().db.users.getById(resolveUserId(req))?.role !== 'admin') {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: 'admin required' }));
                    return true;
                }
                const { address } = await readJsonBodyStrict<{ address?: string }>(req);
                if (!address) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address is required' }));
                    return true;
                }
                const result = await this.adbClient.disconnect(address);
                const success = result.includes('disconnected');
                res.writeHead(success ? 200 : 500);
                res.end(JSON.stringify({ success, message: result.trim() }));
                return true;
            }

            if (req.method === 'GET' && url.startsWith('/api/devices/screen-state')) {
                const parsedUrl = new URL(url, `http://${req.headers.host}`);
                const udid = parsedUrl.searchParams.get('udid');
                if (!udid) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid is required' }));
                    return true;
                }
                if (!requireDeviceAccess(req, res, udid)) return true;
                const output = await this.adbClient.shell(udid, 'dumpsys power 2>/dev/null | grep mWakefulness');
                const awake = output.includes('Awake');
                res.writeHead(200);
                res.end(JSON.stringify({ awake }));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/sleep-wake') {
                const { udid, action } = await readJsonBodyStrict<{ udid?: string; action?: string }>(req);
                if (!udid || !action) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid and action are required' }));
                    return true;
                }
                if (!requireDeviceAccess(req, res, udid)) return true;
                const keyevent = action === 'sleep' ? 223 : 224;
                await this.adbClient.shell(udid, `input keyevent ${keyevent}`);
                if (action === 'wake') {
                    await this.adbClient.shell(udid, 'wm dismiss-keyguard 2>/dev/null || true');
                }
                // Re-check state after a brief delay for the device to respond
                await new Promise((r) => setTimeout(r, 500));
                const output = await this.adbClient.shell(udid, 'dumpsys power 2>/dev/null | grep mWakefulness');
                const awake = output.includes('Awake');
                res.writeHead(200);
                res.end(JSON.stringify({ awake }));
                return true;
            }

            if (req.method === 'GET' && url === '/api/devices/labels') {
                const labels = Config.getInstance().db.devices.getAllLabels(resolveUserId(req));
                res.writeHead(200);
                res.end(JSON.stringify(labels));
                return true;
            }

            if (req.method === 'PUT' && url === '/api/devices/labels') {
                const { serial, label } = await readJsonBodyStrict<{ serial?: string; label?: string }>(req);
                if (!serial) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'serial is required' }));
                    return true;
                }
                if (!requireDeviceAccess(req, res, serial)) return true;
                const db = Config.getInstance().db;
                const userId = resolveUserId(req);
                if (label) {
                    db.devices.setLabel(userId, serial, label);
                } else {
                    db.devices.deleteLabel(userId, serial);
                }
                RealtimeEventsApi.publish('devices');
                res.writeHead(200);
                res.end(JSON.stringify({ success: true }));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/files/delete') {
                const { udid, paths } = await readJsonBodyStrict<{ udid?: string; paths?: unknown }>(req);
                if (!udid) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid is required' }));
                    return true;
                }
                if (!requireDeviceAccess(req, res, udid)) return true;
                let safePaths: string[];
                try {
                    // Bound + validate the targets before any privileged delete:
                    // refuses unbounded lists, traversal, and catastrophic roots
                    // (/sdcard, /data, …). udid is serial-checked by adbClient.
                    safePaths = assertDeletablePaths(paths);
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: (e as Error).message }));
                    return true;
                }
                const errors: { path: string; error: string }[] = [];
                for (const filePath of safePaths) {
                    try {
                        await this.adbClient.shell(udid, `rm -rf ${shArg(filePath)}`);
                    } catch (err) {
                        errors.push({ path: filePath, error: (err as Error).message });
                    }
                }
                const success = errors.length === 0;
                res.writeHead(success ? 200 : 207);
                res.end(JSON.stringify({ success, errors: errors.length > 0 ? errors : undefined }));
                return true;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err: any) {
            if (err instanceof BodyTooLargeError) {
                res.writeHead(413);
                res.end(JSON.stringify({ error: 'request body too large' }));
                return true;
            }
            if (err instanceof InvalidJsonError) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'invalid JSON body' }));
                return true;
            }
            log.error(`${req.method} ${req.url} threw: ${err?.message ?? String(err)}`);
            sendInternalError(res);
            return true;
        }
    }
}
