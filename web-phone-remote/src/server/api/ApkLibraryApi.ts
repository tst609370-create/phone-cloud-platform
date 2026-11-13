import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { AdbClient } from '../AdbClient';
import { resolveUserId } from '../auth/currentUser';
import { canAccessDevice } from '../auth/deviceAccess';
import { requireAdmin } from '../auth/requireAdmin';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { ensureMicApp, MIC_APP_PKG, MIC_APP_VERSION, resolveMicApk } from '../micApp';
import { assertSerial } from '../security/deviceInput';
import { safeUploadName, saveUploadRequest } from './DeviceFileApi';
import { RealtimeEventsApi } from './RealtimeEventsApi';
import { readJsonBody, sendInternalError } from './utils';

const log = Logger.for('ApkLibraryApi');
type ApkAdb = Pick<AdbClient, 'devices' | 'install'> & Partial<Pick<AdbClient, 'shell' | 'forward' | 'removeForward'>>;

function installError(reason: unknown): string {
    const e = reason as { message?: string; cause?: { stdout?: string; stderr?: string } };
    const text = `${e?.cause?.stdout ?? ''} ${e?.cause?.stderr ?? ''}`.trim() || String(e?.message ?? reason ?? '');
    const short =
        text
            .replace(/\(path=[^)]*\)/, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160) || '安装失败';
    return /USER_RESTRICTED/i.test(text) ? `${short}。小米手机要在「开发者选项」打开「USB 安装」` : short;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

/** File name of the bundled no-root sound app in the APK library. */
export const BUNDLED_MIC_APK_NAME = 'PhoneSound-shoujishengyin.apk';

export class ApkLibraryApi {
    constructor(
        private readonly adb: ApkAdb = new AdbClient(Config.getInstance().adbPath),
        private readonly root = path.join(
            Config.getInstance().dataRoot ?? path.dirname(Config.getInstance().dependenciesPath),
            'apk-library',
        ),
        private readonly bundledMicApk: string | undefined = resolveMicApk(),
    ) {}

    /**
     * Put the bundled 「手机声音」 app (no-root phone sound) into the library once,
     * so it can be batch-installed like any other APK. A marker file keeps an
     * admin's delete from being undone on the next listing.
     */
    private async seedBundled(): Promise<void> {
        if (!this.bundledMicApk) return;
        const marker = path.join(this.root, `.seeded-${MIC_APP_PKG}-v${MIC_APP_VERSION}`);
        try {
            await stat(marker);
            return;
        } catch {
            /* not seeded yet */
        }
        try {
            await copyFile(this.bundledMicApk, path.join(this.root, BUNDLED_MIC_APK_NAME));
            await writeFile(marker, '');
        } catch {
            /* bundled file missing: nothing to seed */
        }
    }

    private parseSerials(res: ServerResponse, value: unknown): string[] | undefined {
        const requested = Array.isArray(value) ? value : [];
        try {
            const serials = [...new Set(requested.map((serial) => assertSerial(serial)))];
            if (serials.length > 0 && serials.length <= 50) return serials;
        } catch {
            /* fall through */
        }
        sendJson(res, 400, { error: '请选择 1 至 50 台手机' });
        return undefined;
    }

    private allowed(req: IncomingMessage, res: ServerResponse, serials: string[]): boolean {
        const db = Config.getInstance().db;
        const userId = resolveUserId(req);
        if (serials.some((serial) => !canAccessDevice(db, userId, serial))) {
            sendJson(res, 403, { error: '设备未分配' });
            return false;
        }
        return true;
    }

    private async connectedSerials(): Promise<Set<string>> {
        return new Set(
            (await this.adb.devices()).filter((device) => device.state === 'device').map((device) => device.serial),
        );
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (
            url.pathname !== '/api/apks' &&
            url.pathname !== '/api/apks/install' &&
            url.pathname !== '/api/apks/install-sound'
        )
            return false;
        const adminOnly = req.method === 'DELETE' || (req.method === 'POST' && url.pathname === '/api/apks');
        if (adminOnly && !requireAdmin(req, res)) return true;

        try {
            await mkdir(this.root, { recursive: true });
            if (req.method === 'GET' && url.pathname === '/api/apks') {
                await this.seedBundled();
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

            if (req.method === 'POST' && url.pathname === '/api/apks/install-sound') {
                // 「手机声音」App: install + grant the permissions, one phone or many.
                const body = await readJsonBody(req);
                const serials = this.parseSerials(res, body['devices']);
                if (!serials) return true;
                if (!this.bundledMicApk) {
                    sendJson(res, 404, { error: '这个版本没有带「手机声音」App' });
                    return true;
                }
                if (!this.allowed(req, res, serials)) return true;
                const connected = await this.connectedSerials();
                const apk = this.bundledMicApk;
                const results = await Promise.all(
                    serials.map(async (serial) => {
                        if (!connected.has(serial)) return { serial, ok: false, error: '手机未连接' };
                        try {
                            const problem = await ensureMicApp(this.adb as never, serial, apk);
                            return problem ? { serial, ok: false, error: problem } : { serial, ok: true };
                        } catch (error) {
                            return { serial, ok: false, error: installError(error) };
                        }
                    }),
                );
                log.info(`install sound app: ${JSON.stringify(results)}`);
                sendJson(res, 200, { results });
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
                const connected = await this.connectedSerials();
                const online = serials.filter((serial) => connected.has(serial));
                if (online.length === 0) {
                    sendJson(res, 409, { error: '手机未连接', devices: serials });
                    return true;
                }
                const settled = await Promise.allSettled(
                    serials.map((serial) =>
                        connected.has(serial)
                            ? this.adb.install(serial, localFile)
                            : Promise.reject(new Error('手机未连接')),
                    ),
                );
                const results = settled.map((result, index) =>
                    result.status === 'fulfilled'
                        ? { serial: serials[index], ok: true }
                        : { serial: serials[index], ok: false, error: installError(result.reason) },
                );
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
