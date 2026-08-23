import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdbClient } from '../AdbClient';
import { DeviceDiscoveryApi, uiLabelAtPoint } from '../api/DeviceDiscoveryApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-frame-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
    Config.getInstance();
    const adb = {
        execOut: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
        shell: vi.fn(async () => ''),
    };
    return { api: new DeviceDiscoveryApi(adb as unknown as AdbClient), adb };
}

afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('DeviceDiscoveryApi snapshot remote control', () => {
    it('finds the smallest labelled UI node at a tap coordinate', () => {
        const xml = '<node content-desc="" bounds="[0,0][1080,2400]"><node text="消息" content-desc="消息，按钮" bounds="[600,2100][800,2234]" /></node>';
        expect(uiLabelAtPoint(xml, 700, 2150)).toBe('消息');
        expect(uiLabelAtPoint(xml, 100, 100)).toBeUndefined();
    });

    it('serves an ETagged PNG and returns 304 when the screen is unchanged', async () => {
        const { api, adb } = setup();
        const first = makeReqRes('GET', '/api/devices/frame?udid=S1');
        await api.handle(first.req, first.res);
        expect(first.getStatus()).toBe(200);
        expect(first.getHeader('content-type')).toBe('image/png');
        const etag = first.getHeader('etag');
        expect(etag).toMatch(/^"[a-f0-9]{40}"$/);

        const second = makeReqRes('GET', '/api/devices/frame?udid=S1', undefined, { 'if-none-match': etag! });
        await api.handle(second.req, second.res);
        expect(second.getStatus()).toBe(304);
        expect(adb.execOut).toHaveBeenCalledOnce();
    });

    it('maps a swipe to a bounded ADB input command', async () => {
        const { api, adb } = setup();
        const request = makeReqRes('POST', '/api/devices/input', {
            udid: 'S1', action: 'swipe', x: 10.2, y: 20.8, x2: 30, y2: 40, duration: 240,
        });
        await api.handle(request.req, request.res);
        expect(request.getStatus()).toBe(204);
        expect(adb.shell).toHaveBeenCalledWith('S1', 'input swipe 10 21 30 40 240', 8_000);
    });

    it('returns the changed frame in the same response as the input', async () => {
        const { api, adb } = setup();
        const request = makeReqRes('POST', '/api/devices/input?frame=1', { udid: 'S1', action: 'tap', x: 10, y: 20 });
        await api.handle(request.req, request.res);
        expect(request.getStatus()).toBe(200);
        expect(request.getHeader('content-type')).toBe('image/png');
        expect(adb.shell).toHaveBeenCalledWith('S1', 'input tap 10 20', 8_000);
        expect(adb.execOut).toHaveBeenCalledOnce();
    });

    it('rejects invalid coordinates before invoking ADB', async () => {
        const { api, adb } = setup();
        const request = makeReqRes('POST', '/api/devices/input', { udid: 'S1', action: 'tap', x: -1, y: 20 });
        await api.handle(request.req, request.res);
        expect(request.getStatus()).toBe(400);
        expect(adb.shell).not.toHaveBeenCalled();
    });

    it('returns the semantic label under a tap coordinate', async () => {
        const { api, adb } = setup();
        adb.shell.mockResolvedValue('<node text="我" content-desc="" bounds="[850,2100][1080,2234]" />');
        const request = makeReqRes('GET', '/api/devices/element?udid=S1&x=960&y=2160');
        await api.handle(request.req, request.res);
        expect(request.getStatus()).toBe(200);
        expect(request.getJson()).toEqual({ label: '我' });
    });
});
