import { describe, expect, it } from 'vitest';
import type { AppSettingsStore } from './db/AppSettingsStore';
import {
    LOCAL_EMULATOR_PORTS,
    needsReconnect,
    normalizeAddress,
    readSaved,
    removeDevice,
    saveDevice,
    scanLocalEmulators,
    withStatus,
} from './remoteDevices';

function memoryStore(): AppSettingsStore {
    const data = new Map<string, string>();
    return {
        get: (key: string) => (data.has(key) ? JSON.parse(data.get(key)!) : undefined),
        getAll: () => Object.fromEntries([...data].map(([k, v]) => [k, JSON.parse(v)])),
        set: (key: string, value: unknown) => void data.set(key, JSON.stringify(value)),
    } as unknown as AppSettingsStore;
}

describe('normalizeAddress', () => {
    it('accepts host:port, adds default port, strips adb connect prefix', () => {
        expect(normalizeAddress(' 127.0.0.1:5555 ')).toBe('127.0.0.1:5555');
        expect(normalizeAddress('192.168.1.8')).toBe('192.168.1.8:5555');
        expect(normalizeAddress('adb connect 10.0.0.2:40001')).toBe('10.0.0.2:40001');
        expect(normalizeAddress('Cloud.Example.com:30005')).toBe('cloud.example.com:30005');
    });
    it('rejects junk and injection attempts', () => {
        for (const bad of [
            '',
            ':5555',
            '1.2.3.4:0',
            '1.2.3.4:70000',
            '-s x:1',
            'a b:1',
            'a;rm:1',
            '1.2.3.4:55:55',
            42,
            null,
        ]) {
            expect(normalizeAddress(bad)).toBeNull();
        }
    });
});

describe('saved list', () => {
    it('saves, dedupes, updates label, removes', () => {
        const store = memoryStore();
        saveDevice(store, '127.0.0.1:5555', 'BlueStacks', 1);
        saveDevice(store, '127.0.0.1:5555', '模拟器', 2);
        saveDevice(store, '1.2.3.4:5555', '', 3);
        expect(readSaved(store)).toEqual([
            { address: '127.0.0.1:5555', label: '模拟器', addedAt: 1 },
            { address: '1.2.3.4:5555', label: '', addedAt: 3 },
        ]);
        expect(removeDevice(store, '127.0.0.1:5555')).toBe(true);
        expect(removeDevice(store, '127.0.0.1:5555')).toBe(false);
        expect(readSaved(store).map((d) => d.address)).toEqual(['1.2.3.4:5555']);
    });
    it('ignores corrupted entries', () => {
        const store = memoryStore();
        store.set('remoteDevices', [{ address: 'bad host:1' }, { address: '1.1.1.1:5' }, 'x']);
        expect(readSaved(store).map((d) => d.address)).toEqual(['1.1.1.1:5']);
        store.set('remoteDevices', 'nope');
        expect(readSaved(store)).toEqual([]);
    });
});

describe('reconnect selection', () => {
    const saved = [
        { address: 'a:1', label: '', addedAt: 0 },
        { address: 'b:1', label: '', addedAt: 0 },
        { address: 'c:1', label: '', addedAt: 0 },
        { address: 'd:1', label: '', addedAt: 0 },
    ];
    const adb = [
        { serial: 'a:1', state: 'device' },
        { serial: 'b:1', state: 'offline' },
        { serial: 'c:1', state: 'unauthorized' },
        { serial: 'HD1907', state: 'device' },
    ];
    it('reconnects missing and offline, leaves connected/unauthorized alone', () => {
        expect(needsReconnect(saved, adb).map((d) => d.address)).toEqual(['b:1', 'd:1']);
    });
    it('reports adb state per saved address', () => {
        expect(withStatus(saved, adb).map((d) => d.state)).toEqual(['device', 'offline', 'unauthorized', '']);
    });
});

describe('scanLocalEmulators', () => {
    it('returns only ports that answer the adb handshake', async () => {
        const hits = await scanLocalEmulators(async (_host, port) =>
            port === 5555 ? { isAdb: true, model: 'SM-S908E' } : port === 16384 ? { isAdb: true } : { isAdb: false },
        );
        expect(hits).toEqual([
            { address: '127.0.0.1:5555', name: 'BlueStacks', model: 'SM-S908E' },
            { address: '127.0.0.1:16384', name: 'MuMu 12', model: undefined },
        ]);
        expect(new Set(LOCAL_EMULATOR_PORTS.map((p) => p.port)).size).toBe(LOCAL_EMULATOR_PORTS.length);
    });
});
