import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaintApi } from '../api/MaintApi';
import { AuthGate } from '../auth/AuthGate';
import { setAuthEnabled } from '../auth/authState';
import { isValidMaintKey, revokeMaintKey, rotateMaintKey } from '../auth/maintKey';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { evaluateHttpRequest } from '../security/requestGate';
import { makeReqRes } from './helpers/httpMock';

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
    return dir;
}

afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function fakeAdb() {
    return {
        devices: vi.fn(async () => [
            { serial: 'abc123', state: 'device' },
            { serial: '10.0.0.5:5555', state: 'offline' },
        ]),
        getProperties: vi.fn(async () => ({ 'ro.product.model': 'LE2100', 'ro.product.manufacturer': 'OnePlus' })),
        shell: vi.fn(async (_s: string, c: string) => `ran:${c}`),
        connect: vi.fn(async (a: string) => `connected to ${a}`),
        disconnect: vi.fn(async (a: string) => `disconnected ${a}`),
        reconnect: vi.fn(async () => 'reconnecting'),
        killServer: vi.fn(async () => {}),
        startServer: vi.fn(async () => {}),
    };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}`, host: '81.71.94.90:10000' });

describe('maint key', () => {
    it('stores only a hash; rotate invalidates the old key; revoke disables', () => {
        setup();
        const db = Config.getInstance().db;
        const k1 = rotateMaintKey(db);
        expect(k1.startsWith('pck_')).toBe(true);
        expect(JSON.stringify(db.appSettings.get('maintApiKey'))).not.toContain(k1);
        expect(isValidMaintKey(db, k1)).toBe(true);
        const k2 = rotateMaintKey(db);
        expect(isValidMaintKey(db, k1)).toBe(false);
        expect(isValidMaintKey(db, k2)).toBe(true);
        revokeMaintKey(db);
        expect(isValidMaintKey(db, k2)).toBe(false);
    });

    it('a valid key replaces the browser instance token, nothing else', () => {
        const args = ['GET', '/api/maint/status', undefined, '81.71.94.90:10000', undefined, false] as const;
        expect(evaluateHttpRequest(...args).allowed).toBe(false);
        expect(evaluateHttpRequest(...args, true).allowed).toBe(true);
        // Host allowlist still applies.
        expect(evaluateHttpRequest('GET', '/api/x', undefined, 'evil.example', undefined, false, true).allowed).toBe(false);
    });

    it('AuthGate lets a valid key through as admin and 401s a wrong one (locked mode)', async () => {
        setup();
        const db = Config.getInstance().db;
        setAuthEnabled(db, true);
        const key = rotateMaintKey(db);
        const gate = new AuthGate(() => db);

        const ok = makeReqRes('GET', '/api/rentals', undefined, bearer(key));
        expect(await gate.handle(ok.req, ok.res)).toBe(false);
        expect((ok.req as unknown as { user: { role: string } }).user.role).toBe('admin');

        const bad = makeReqRes('GET', '/api/rentals', undefined, bearer('pck_wrong'));
        expect(await gate.handle(bad.req, bad.res)).toBe(true);
        expect(bad.getStatus()).toBe(401);
    });
});

describe('MaintApi', () => {
    it('rejects requests without a key in locked mode', async () => {
        setup();
        setAuthEnabled(Config.getInstance().db, true);
        const r = makeReqRes('GET', '/api/maint/status', undefined, { host: '81.71.94.90:10000' });
        await new MaintApi({ adb: fakeAdb() }).handle(r.req, r.res);
        expect(r.getStatus()).toBe(401);
    });

    it('open mode: only loopback without a key', async () => {
        setup();
        const api = new MaintApi({ adb: fakeAdb() });
        const remote = makeReqRes('GET', '/api/maint/help', undefined, { host: '81.71.94.90:10000' });
        await api.handle(remote.req, remote.res);
        expect(remote.getStatus()).toBe(401);
        const local = makeReqRes('GET', '/api/maint/help', undefined, { host: '127.0.0.1:8000' });
        await api.handle(local.req, local.res);
        expect(local.getStatus()).toBe(200);
        expect(local.getBody()).toContain('/api/maint/status');
    });

    it('status lists devices with model for online ones', async () => {
        setup();
        const db = Config.getInstance().db;
        setAuthEnabled(db, true);
        const key = rotateMaintKey(db);
        const r = makeReqRes('GET', '/api/maint/status', undefined, bearer(key));
        await new MaintApi({ adb: fakeAdb() }).handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        const body = r.getJson() as { authEnabled: boolean; devices: Array<Record<string, string>> };
        expect(body.authEnabled).toBe(true);
        expect(body.devices).toEqual([
            { serial: 'abc123', state: 'device', model: 'LE2100', manufacturer: 'OnePlus', android: '' },
            { serial: '10.0.0.5:5555', state: 'offline' },
        ]);
    });

    it('logs: lists files, tails with grep, refuses names outside the list', async () => {
        const dir = setup();
        const db = Config.getInstance().db;
        const key = rotateMaintKey(db);
        const logDir = path.join(dir, 'logs');
        fs.mkdirSync(logDir);
        fs.writeFileSync(path.join(logDir, 'node.log'), 'a ok\nb ERROR boom\nc ok\nd error two\n');
        const api = new MaintApi({ adb: fakeAdb(), logDir });

        const list = makeReqRes('GET', '/api/maint/logs', undefined, bearer(key));
        await api.handle(list.req, list.res);
        expect((list.getJson() as { files: Array<{ name: string }> }).files.map((f) => f.name)).toEqual(['node.log']);

        const tail = makeReqRes('GET', '/api/maint/logs?file=node.log&lines=1&grep=error', undefined, bearer(key));
        await api.handle(tail.req, tail.res);
        expect((tail.getJson() as { lines: string[] }).lines).toEqual(['d error two']);

        const evil = makeReqRes('GET', '/api/maint/logs?file=..%2Fconfig.json', undefined, bearer(key));
        await api.handle(evil.req, evil.res);
        expect(evil.getStatus()).toBe(404);
    });

    it('adb actions validate input and call adb', async () => {
        setup();
        const key = rotateMaintKey(Config.getInstance().db);
        const adb = fakeAdb();
        const api = new MaintApi({ adb });

        const sh = makeReqRes('POST', '/api/maint/adb', { action: 'shell', device: 'abc123', command: 'id' }, bearer(key));
        await api.handle(sh.req, sh.res);
        expect(sh.getJson()).toEqual({ ok: true, output: 'ran:id' });

        const badSerial = makeReqRes('POST', '/api/maint/adb', { action: 'shell', device: '-H evil', command: 'id' }, bearer(key));
        await api.handle(badSerial.req, badSerial.res);
        expect(badSerial.getStatus()).toBe(400);

        const badAddr = makeReqRes('POST', '/api/maint/adb', { action: 'connect', address: '-L tcp:1' }, bearer(key));
        await api.handle(badAddr.req, badAddr.res);
        expect(badAddr.getStatus()).toBe(400);

        const rc = makeReqRes('POST', '/api/maint/adb', { action: 'reconnect', device: '10.0.0.5:5555' }, bearer(key));
        await api.handle(rc.req, rc.res);
        expect(adb.reconnect).toHaveBeenCalledWith('10.0.0.5:5555');

        const rs = makeReqRes('POST', '/api/maint/adb', { action: 'restart-server' }, bearer(key));
        await api.handle(rs.req, rs.res);
        expect(adb.killServer).toHaveBeenCalled();
        expect(adb.startServer).toHaveBeenCalled();
    });

    it('restart answers first, then restarts', async () => {
        vi.useFakeTimers();
        try {
            setup();
            const key = rotateMaintKey(Config.getInstance().db);
            const restart = vi.fn();
            const r = makeReqRes('POST', '/api/maint/restart', undefined, bearer(key));
            await new MaintApi({ adb: fakeAdb(), restart }).handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect(restart).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(300);
            expect(restart).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});
