import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { AdbClient } from '../AdbClient';
import { resolveUserId } from '../auth/currentUser';
import { canAccessDevice } from '../auth/deviceAccess';
import { requireAdmin } from '../auth/requireAdmin';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { assertSerial } from '../security/deviceInput';
import { safeUploadName, saveUploadRequest } from './DeviceFileApi';
import { RealtimeEventsApi } from './RealtimeEventsApi';
import { readJsonBody, sendInternalError } from './utils';

const log = Logger.for('ApkLibraryApi');
type ApkAdb = Pick<AdbClient, 'devices' | 'install'>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

export class ApkLibraryApi {
    constructor(
        private readonly adb: ApkAdb = new AdbClient(Config.getInstance().adbPath),
        private readonly root = path.join(
            Config.getInstance().dataRoot ?? path.dirname(Config.getInstance().dependenciesPath),
            'apk-library',
        ),
    ) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/api/apks' && url.pathname !== '/api/apks/install') return false;
        const adminOnly = req.method === 'DELETE' || (req.method === 'POST' && url.pathname === '/api/apks');
        if (adminOnly && !requireAdmin(req, res)) return true;

        try {
            await mkdir(this.root, { recursive: true });
            if (req.method === 'GET' && url.pathname === '/api/apks') {
                const entries = await readdir(this.root, { withFileTypes: true });
                const apks = await Promise.all(
                    entries
                        .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.apk')
                        .map(async (entry) => {
                            const info = await stat(path.join(this.root, entry.name));
                            return { name: entry.name, size: info.size, modifiedAt: info.mtimeMs };
                        }),
                );
                apks.sort((a, b) => b.modifiedAt - a.modifiedAt);
                sendJson(res, 200, { apks });
                return true;
            }

            if (req.method === 'POST' && url.pathname === '/api/apks') {
                let name: string;
                try {
                    name = safeUploadName(url.searchParams.get('name') ?? '');
                } catch {
                    sendJson(res, 400, { error: '文件名无效' });
                    return true;
                }
                if (path.extname(name).toLowerCase() !== '.apk') {
                    sendJson(res, 415, { error: '只支持 APK 安装包' });
                    return true;
                }
                const target = path.join(this.root, name);
                try {
                    await saveUploadRequest(req, target);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                        sendJson(res, 409, { error: '同名 APK 已存在，请先删除旧文件' });
                    } else {
                        await rm(target, { force: true }).catch(() => undefined);
                        if (error instanceof Error && error.message === 'upload too large') {
                            sendJson(res, 413, { error: 'APK 不能超过 512 MB' });
                        } else {
                            throw error;
                        }
                    }
                    return true;
                }
                RealtimeEventsApi.publish('apks');
                sendJson(res, 201, { ok: true, name });
                return true;
            }

            if (req.method === 'DELETE' && url.pathname === '/api/apks') {
                let name: string;
                try {
                    name = safeUploadName(url.searchParams.get('name') ?? '');
                } catch {
                    sendJson(res, 400, { error: '文件名无效' });
                    return true;
                }
                if (path.extname(name).toLowerCase() !== '.apk') {
                    sendJson(res, 400, { error: '文件名无效' });
                    return true;
                }
                await rm(path.join(this.root, name), { force: true });
                RealtimeEventsApi.publish('apks');
                sendJson(res, 200, { ok: true });
                return true;
            }

            if (req.method === 'POST' && url.pathname === '/api/apks/install') {
                const body = await readJsonBody(req);
                let name: string;
                try {
                    name = safeUploadName(body['name'] as string);
                } catch {
                    sendJson(res, 400, { error: 'APK 文件名无效' });
                    return true;
                }
                const requested = Array.isArray(body['devices']) ? body['devices'] : [];
                let serials: string[];
                try {
                    serials = [...new Set(requested.map((serial) => assertSerial(serial)))];
                } catch {
                    sendJson(res, 400, { error: '设备序列号无效' });
                    return true;
                }
                if (path.extname(name).toLowerCase() !== '.apk' || serials.length === 0 || serials.length > 50) {
                    sendJson(res, 400, { error: '请选择 APK 和 1 至 50 台手机' });
                    return true;
                }
                const db = Config.getInstance().db;
                const userId = resolveUserId(req);
                if (serials.some((serial) => !canAccessDevice(db, userId, serial))) {
                    sendJson(res, 403, { error: '设备未分配' });
                    return true;
                }
                const localFile = path.join(this.root, name);
                try {
                    await stat(localFile);
                } catch {
                    sendJson(res, 404, { error: 'APK 不存在' });
                    return true;
                }
                const connected = new Set(
                    (await this.adb.devices())
                        .filter((device) => device.state === 'device')
                        .map((device) => device.serial),
                );
                const offline = serials.filter((serial) => !connected.has(serial));
                if (offline.length) {
                    sendJson(res, 409, { error: '部分手机未连接', devices: offline });
                    return true;
                }
                const settled = await Promise.allSettled(serials.map((serial) => this.adb.install(serial, localFile)));
                const results = settled.map((result, index) => ({
                    serial: serials[index],
                    ok: result.status === 'fulfilled',
                }));
                sendJson(res, 200, { results });
                return true;
            }

            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        } catch (error) {
            log.error('APK library operation failed', error);
            sendInternalError(res);
            return true;
        }
    }
}
