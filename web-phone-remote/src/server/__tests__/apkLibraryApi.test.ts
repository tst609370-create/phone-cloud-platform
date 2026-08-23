import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApkLibraryApi } from '../api/ApkLibraryApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

const roots: string[] = [];
const savedConfig = process.env[EnvName.CONFIG_PATH];
const savedDeps = process.env['DEPS_PATH'];

function setup(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-library-'));
    roots.push(root);
    process.env[EnvName.CONFIG_PATH] = path.join(root, 'config.json');
    process.env['DEPS_PATH'] = path.join(root, 'dependencies');
    fs.writeFileSync(process.env[EnvName.CONFIG_PATH], JSON.stringify({ webPort: 8000 }));
    Config._resetForTest();
    return path.join(root, 'apks');
}

afterEach(() => {
    Config._resetForTest();
    if (savedConfig === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = savedConfig;
    if (savedDeps === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = savedDeps;
    while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ApkLibraryApi', () => {
    it('lists saved APKs and installs one on every selected connected phone', async () => {
        const root = setup();
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'douyin.apk'), 'apk');
        const installed: string[] = [];
        const adb = {
            devices: async () => [
                { serial: 'PHONE_A', state: 'device' },
                { serial: 'PHONE_B', state: 'device' },
            ],
            install: async (serial: string) => {
                installed.push(serial);
                return 'Success';
            },
        };
        const api = new ApkLibraryApi(adb as never, root);

        const list = makeReqRes('GET', '/api/apks');
        await api.handle(list.req, list.res);
        expect(list.getJson()).toMatchObject({ apks: [{ name: 'douyin.apk', size: 3 }] });

        const duplicate = makeReqRes('POST', '/api/apks?name=douyin.apk', 'replacement');
        await api.handle(duplicate.req, duplicate.res);
        expect(duplicate.getStatus()).toBe(409);
        expect(fs.readFileSync(path.join(root, 'douyin.apk'), 'utf8')).toBe('apk');

        const install = makeReqRes('POST', '/api/apks/install', {
            name: 'douyin.apk',
            devices: ['PHONE_A', 'PHONE_B'],
        });
        await api.handle(install.req, install.res);
        expect(install.getStatus()).toBe(200);
        expect(install.getJson()).toEqual({
            results: [
                { serial: 'PHONE_A', ok: true },
                { serial: 'PHONE_B', ok: true },
            ],
        });
        expect(installed).toEqual(['PHONE_A', 'PHONE_B']);
    });

    it('lets a rental user list APKs and install only on assigned phones', async () => {
        const root = setup();
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'tool.apk'), 'apk');
        const db = Config.getInstance().db;
        const tenant = db.users.create({ username: 'ab123456', role: 'user', passwordHash: 'x' });
        db.devices.setAssignments(tenant.id, ['PHONE_A']);
        const installed: string[] = [];
        const api = new ApkLibraryApi({
            devices: async () => [
                { serial: 'PHONE_A', state: 'device' },
                { serial: 'PHONE_B', state: 'device' },
            ],
            install: async (serial: string) => {
                installed.push(serial);
                return 'Success';
            },
        } as never, root);

        const list = makeReqRes('GET', '/api/apks');
        (list.req as typeof list.req & { user: { id: number } }).user = { id: tenant.id };
        await api.handle(list.req, list.res);
        expect(list.getStatus()).toBe(200);
        expect(list.getJson()).toMatchObject({ apks: [{ name: 'tool.apk' }] });

        const allowed = makeReqRes('POST', '/api/apks/install', { name: 'tool.apk', devices: ['PHONE_A'] });
        (allowed.req as typeof allowed.req & { user: { id: number } }).user = { id: tenant.id };
        await api.handle(allowed.req, allowed.res);
        expect(allowed.getStatus()).toBe(200);

        const denied = makeReqRes('POST', '/api/apks/install', { name: 'tool.apk', devices: ['PHONE_B'] });
        (denied.req as typeof denied.req & { user: { id: number } }).user = { id: tenant.id };
        await api.handle(denied.req, denied.res);
        expect(denied.getStatus()).toBe(403);
        expect(installed).toEqual(['PHONE_A']);
    });
});
