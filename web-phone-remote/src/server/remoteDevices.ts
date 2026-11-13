/**
 * Saved network devices (emulators on this PC, cloud phones that expose an
 * ADB address). `adb connect host:port` is forgotten when the adb server or
 * the PC restarts, so the addresses live in app_settings and a background
 * loop re-connects any that are missing from `adb devices`.
 */
import type { AdbClient, AdbDevice } from './AdbClient';
import type { AppSettingsStore } from './db/AppSettingsStore';
import { Logger } from './Logger';
import { probeAdb } from './network/AdbHandshakeProbe';

const log = Logger.for('RemoteDevices');

export const REMOTE_DEVICES_KEY = 'remoteDevices';

export interface SavedRemoteDevice {
    address: string;
    label: string;
    addedAt: number;
}

export interface RemoteDeviceStatus extends SavedRemoteDevice {
    /** adb state for this serial: device / offline / unauthorized / '' (not connected). */
    state: string;
}

const HOST_RE =
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Normalize user input ("127.0.0.1", " 1.2.3.4:5555 ", "adb connect x:y") to host:port, or null. */
export function normalizeAddress(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    let text = input
        .trim()
        .replace(/^adb\s+connect\s+/i, '')
        .replace(/^\w+:\/\//, '')
        .replace(/\/+$/, '');
    if (!text) return null;
    if (!text.includes(':')) text += ':5555';
    const match = /^([^:\s]+):(\d{1,5})$/.exec(text);
    if (!match) return null;
    const host = match[1]!.toLowerCase();
    const port = Number(match[2]);
    if (!(port >= 1 && port <= 65535)) return null;
    if (host.length > 253 || !HOST_RE.test(host)) return null;
    return `${host}:${port}`;
}

export function readSaved(store: AppSettingsStore): SavedRemoteDevice[] {
    const raw = store.get(REMOTE_DEVICES_KEY);
    if (!Array.isArray(raw)) return [];
    const out: SavedRemoteDevice[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        const address = normalizeAddress((item as SavedRemoteDevice)?.address);
        if (!address || seen.has(address)) continue;
        seen.add(address);
        const label = typeof item.label === 'string' ? item.label.slice(0, 40) : '';
        out.push({ address, label, addedAt: Number(item.addedAt) || 0 });
    }
    return out;
}

export function saveDevice(
    store: AppSettingsStore,
    address: string,
    label: string,
    now = Date.now(),
): SavedRemoteDevice[] {
    const list = readSaved(store);
    const existing = list.find((d) => d.address === address);
    if (existing) existing.label = label.slice(0, 40);
    else list.push({ address, label: label.slice(0, 40), addedAt: now });
    store.set(REMOTE_DEVICES_KEY, list);
    return list;
}

export function removeDevice(store: AppSettingsStore, address: string): boolean {
    const list = readSaved(store);
    const next = list.filter((d) => d.address !== address);
    store.set(REMOTE_DEVICES_KEY, next);
    return next.length !== list.length;
}

export function withStatus(saved: SavedRemoteDevice[], adbDevices: AdbDevice[]): RemoteDeviceStatus[] {
    const states = new Map(adbDevices.map((d) => [d.serial, d.state]));
    return saved.map((d) => ({ ...d, state: states.get(d.address) ?? '' }));
}

/** Saved addresses that need a (re)connect: missing from adb, or stuck offline. */
export function needsReconnect(saved: SavedRemoteDevice[], adbDevices: AdbDevice[]): SavedRemoteDevice[] {
    const states = new Map(adbDevices.map((d) => [d.serial, d.state]));
    return saved.filter((d) => {
        const state = states.get(d.address);
        return state === undefined || state === 'offline';
    });
}

/** Common local emulator ADB ports. */
export const LOCAL_EMULATOR_PORTS: Array<{ port: number; name: string }> = [
    ...[5555, 5565, 5575, 5585, 5595, 5605].map((port) => ({ port, name: 'BlueStacks' })),
    ...[5557, 5559, 5561, 5563, 5567, 5569, 5571, 5573, 5577, 5579, 5581, 5583].map((port) => ({
        port,
        name: '雷电/安卓模拟器',
    })),
    { port: 7555, name: 'MuMu' },
    ...Array.from({ length: 8 }, (_, i) => ({ port: 16384 + 32 * i, name: 'MuMu 12' })),
    ...[62001, 62025, 62026, 62027, 62028, 62029].map((port) => ({ port, name: '夜神' })),
    ...Array.from({ length: 4 }, (_, i) => ({ port: 21503 + 10 * i, name: '逍遥' })),
];

export interface ScanHit {
    address: string;
    name: string;
    model?: string | undefined;
}

type Probe = (host: string, port: number) => Promise<{ isAdb: boolean; model?: string | undefined }>;

/** Probe localhost emulator ports with a real ADB handshake (no adb connect side effects). */
export async function scanLocalEmulators(probe: Probe = (h, p) => probeAdb(h, p, 400, 1_200)): Promise<ScanHit[]> {
    const results = await Promise.all(
        LOCAL_EMULATOR_PORTS.map(async ({ port, name }): Promise<ScanHit | null> => {
            try {
                const r = await probe('127.0.0.1', port);
                return r.isAdb ? { address: `127.0.0.1:${port}`, name, model: r.model } : null;
            } catch {
                return null;
            }
        }),
    );
    return results.filter((r): r is ScanHit => r !== null);
}

export async function connectAddress(adb: AdbClient, address: string): Promise<{ success: boolean; message: string }> {
    try {
        const out = (await adb.connect(address)).trim().replace(/\s+/g, ' ');
        // adb prints "connected to x" / "already connected to x"; failures print "failed to connect" / "cannot connect".
        const success = /\bconnected to\b/.test(out) && !/failed|cannot|unable/i.test(out);
        return { success, message: out };
    } catch (err) {
        return { success: false, message: (err as Error).message };
    }
}

/** Background re-connect loop. Returns a stop function. */
export function startReconnectLoop(adb: AdbClient, store: AppSettingsStore, intervalMs = 20_000): () => void {
    let running = false;
    let stopped = false;
    const tick = async (): Promise<void> => {
        if (running || stopped) return;
        running = true;
        try {
            const saved = readSaved(store);
            if (!saved.length) return;
            const devices = await adb.devices();
            for (const d of needsReconnect(saved, devices)) {
                if (devices.some((x) => x.serial === d.address && x.state === 'offline')) {
                    await adb.disconnect(d.address).catch(() => undefined);
                }
                const r = await connectAddress(adb, d.address);
                if (r.success) log.info(`reconnected ${d.address}`);
            }
        } catch (err) {
            log.warn(`reconnect tick failed: ${(err as Error).message}`);
        } finally {
            running = false;
        }
    };
    const first = setTimeout(() => void tick(), 3_000);
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
    first.unref?.();
    return () => {
        stopped = true;
        clearTimeout(first);
        clearInterval(timer);
    };
}
