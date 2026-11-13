import type { IncomingMessage, ServerResponse } from 'http';
import { AdbClient } from '../AdbClient';
import { requireAdmin } from '../auth/requireAdmin';
import { Config } from '../Config';
import { Logger } from '../Logger';
import {
    connectAddress,
    normalizeAddress,
    readSaved,
    removeDevice,
    saveDevice,
    scanLocalEmulators,
    withStatus,
} from '../remoteDevices';
import { RealtimeEventsApi } from './RealtimeEventsApi';
import { BodyTooLargeError, InvalidJsonError, readJsonBodyStrict, sendInternalError } from './utils';

const log = Logger.for('RemoteDevicesApi');

/**
 * Admin-only management of network devices (emulators / cloud phones):
 *   GET    /api/remote-devices          saved list + adb state
 *   POST   /api/remote-devices          { address, label? }  save + adb connect
 *   DELETE /api/remote-devices          { address }          forget + adb disconnect
 *   POST   /api/remote-devices/scan     probe local emulator ports
 */
export class RemoteDevicesApi {
    private readonly adb: AdbClient;

    constructor(adb?: AdbClient) {
        this.adb = adb ?? new AdbClient(Config.getInstance().adbPath);
    }

    private send(res: ServerResponse, status: number, body: unknown): true {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return true;
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const path = (req.url || '').split('?')[0];
        if (path !== '/api/remote-devices' && path !== '/api/remote-devices/scan') return false;
        if (!requireAdmin(req, res)) return true;
        const store = Config.getInstance().db.appSettings;
        try {
            if (path === '/api/remote-devices/scan') {
                if (req.method !== 'POST') return this.send(res, 405, { error: 'method not allowed' });
                const [hits, devices] = await Promise.all([scanLocalEmulators(), this.adb.devices().catch(() => [])]);
                const saved = new Set(readSaved(store).map((d) => d.address));
                const connected = new Map(devices.map((d) => [d.serial, d.state]));
                return this.send(res, 200, {
                    found: hits.map((h) => ({
                        ...h,
                        saved: saved.has(h.address),
                        state: connected.get(h.address) ?? '',
                    })),
                });
            }
            if (req.method === 'GET') {
                const devices = await this.adb.devices().catch(() => []);
                return this.send(res, 200, { devices: withStatus(readSaved(store), devices) });
            }
            if (req.method === 'POST') {
                const body = await readJsonBodyStrict<{ address?: unknown; label?: unknown }>(req);
                const address = normalizeAddress(body.address);
                if (!address) return this.send(res, 400, { error: '地址格式不对，应为 IP:端口，例如 127.0.0.1:5555' });
                const label = typeof body.label === 'string' ? body.label.trim() : '';
                saveDevice(store, address, label);
                const result = await connectAddress(this.adb, address);
                log.info(`add ${address} → ${result.success ? 'OK' : 'FAIL'}: ${result.message}`);
                RealtimeEventsApi.publish('devices');
                return this.send(res, 200, {
                    address,
                    saved: true,
                    connected: result.success,
                    message: result.message,
                });
            }
            if (req.method === 'DELETE') {
                const body = await readJsonBodyStrict<{ address?: unknown }>(req);
                const address = normalizeAddress(body.address);
                if (!address) return this.send(res, 400, { error: 'address is required' });
                const removed = removeDevice(store, address);
                await this.adb.disconnect(address).catch(() => '');
                RealtimeEventsApi.publish('devices');
                return this.send(res, 200, { removed });
            }
            return this.send(res, 405, { error: 'method not allowed' });
        } catch (err) {
            if (err instanceof BodyTooLargeError) return this.send(res, 413, { error: 'request body too large' });
            if (err instanceof InvalidJsonError) return this.send(res, 400, { error: 'invalid JSON body' });
            log.error(`${req.method} ${req.url} threw: ${(err as Error).message}`);
            sendInternalError(res);
            return true;
        }
    }
}
