import { spawn } from 'child_process';
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { AdbClient } from '../AdbClient';
import { getAppVersion } from '../appVersion';
import { isAuthEnabled, isLoopbackHost } from '../auth/authState';
import { authenticateMaintKey, maintKeyInfo, revokeMaintKey, rotateMaintKey } from '../auth/maintKey';
import { Config } from '../Config';
import { getLogFilePath, Logger } from '../Logger';
import { isValidSerial } from '../security/deviceInput';
import { readJsonBody, sendInternalError } from './utils';

const log = Logger.for('MaintApi');

/** 给 AI 看的接口说明（GET /api/maint/help 原样返回，docs/维护API.md 是给人看的版本）。 */
export const MAINT_HELP = `# 云手机后台维护 API

鉴权：每个请求带请求头 \`Authorization: Bearer <密钥>\`（或 \`X-Maint-Key: <密钥>\`）。
密钥在管理后台「AI 维护」页生成，只显示一次；重新生成后旧密钥立即失效。
带有效密钥时，后台全部 /api/* 都按管理员身份放行（含 /api/devices/*、/api/rentals 等）。

## 维护接口
- GET  /api/maint/help                         本说明（text/markdown）
- GET  /api/maint/status                       版本、前端版本(uiVersion)、运行时长、内存、是否开登录、adb 设备列表
- GET  /api/maint/logs                         列出日志文件
- GET  /api/maint/logs?file=<名>&lines=200&grep=<关键字>   读日志末尾（lines 最多 5000，grep 不区分大小写）
- POST /api/maint/adb  {"action":"devices"}                              adb 设备列表
- POST /api/maint/adb  {"action":"shell","device":"<序列号>","command":"getprop ro.product.model","timeoutMs":30000}
- POST /api/maint/adb  {"action":"reconnect","device":"<序列号>"}       断开重连单台（USB/网络都行）
- POST /api/maint/adb  {"action":"connect","address":"192.168.1.5:5555"} / {"action":"disconnect","address":"..."}
- POST /api/maint/adb  {"action":"restart-server"}                       重启 adb 服务（所有手机会短暂断开）
- POST /api/maint/adb  {"action":"reboot","device":"<序列号>"}          重启手机
- POST /api/maint/restart                       重启后台服务（约 10 秒恢复，期间画面断开）

## 其他常用（已有接口，同样用密钥）
- GET  /api/devices/connected                  在线手机（型号、备注）
- GET  /api/devices/frame?udid=<序列号>        当前画面 JPEG 截图
- GET  /api/rentals                            租用识别码列表
- GET  /api/settings                           设置

返回都是 JSON：成功 {"ok":true,...}，失败 {"error":"..."}（4xx/5xx）。
重启服务、重启 adb、重启手机会打断正在使用的用户，先确认再做。
`;

/** adb 卡住（守护进程起不来、手机无响应）时不要把接口一起拖死。 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} 超时（${ms / 1000} 秒）`)), ms);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

const MAX_LOG_LINES = 5000;
const LOG_TAIL_BYTES = 4 * 1024 * 1024;

export function listLogFiles(dir: string): Array<{ name: string; size: number; mtime: number }> {
    try {
        return fs
            .readdirSync(dir)
            .filter((n) => /\.log(\.\d+)?$/i.test(n))
            .map((name) => {
                const st = fs.statSync(path.join(dir, name));
                return { name, size: st.size, mtime: st.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch {
        return [];
    }
}

/** 读文件末尾 lines 行（只读最后 4MB），可按关键字过滤。 */
export function tailLog(file: string, lines: number, grep?: string): string[] {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - LOG_TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
    let all = text.split(/\r?\n/);
    if (start > 0) all = all.slice(1); // 第一行可能被截断
    if (all.length && all[all.length - 1] === '') all.pop();
    if (grep) {
        const needle = grep.toLowerCase();
        all = all.filter((l) => l.toLowerCase().includes(needle));
    }
    return all.slice(-lines);
}

function readUiVersion(): string | null {
    try {
        const js = fs.readFileSync(path.join(__dirname, 'public', 'phones.js'), 'utf8');
        return /UI_VERSION\s*=\s*'([^']+)'/.exec(js)?.[1] ?? null;
    } catch {
        return null;
    }
}

/**
 * 重启：有启动器托管（DATA_ROOT）时 exit(75) 交给启动器拉起；
 * Windows 一键安装的 run-node.cmd 不会自己重启，所以先放一个脱离的小进程，等本进程退出后用同样的参数重新拉起。
 */
export function relaunchSelf(): void {
    const logFile = path.join(path.dirname(getLogFilePath()), 'node.log');
    const script = `const{spawn}=require('child_process'),fs=require('fs');
const [pid,log,cwd,...argv]=process.argv.slice(1);
const alive=()=>{try{process.kill(+pid,0);return true}catch{return false}};
const t0=Date.now();
(function wait(){if(alive()&&Date.now()-t0<30000)return setTimeout(wait,300);
setTimeout(()=>{let out='ignore';try{out=fs.openSync(log,'a')}catch{}
spawn(process.execPath,argv,{cwd,detached:true,stdio:['ignore',out,out],windowsHide:true}).unref();process.exit(0)},1500)})();`;
    spawn(process.execPath, ['-e', script, String(process.pid), logFile, process.cwd(), ...process.argv.slice(1)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
    }).unref();
}

export interface MaintApiOptions {
    adb?: Pick<AdbClient, 'devices' | 'shell' | 'connect' | 'disconnect' | 'reconnect' | 'getProperties' | 'killServer' | 'startServer'>;
    cleanup?: () => Promise<void>;
    logDir?: string;
    /** 测试替身：默认按运行方式选 exit(75) 或自我重启后 exit(0)。 */
    restart?: () => void;
}

export class MaintApi {
    private readonly startedAt = Date.now();
    private readonly opts: MaintApiOptions;

    constructor(opts: MaintApiOptions = {}) {
        this.opts = opts;
    }

    private get adb(): NonNullable<MaintApiOptions['adb']> {
        if (!this.opts.adb) this.opts.adb = new AdbClient(Config.getInstance().adbPath);
        return this.opts.adb;
    }

    private get logDir(): string {
        return this.opts.logDir ?? path.dirname(getLogFilePath());
    }

    /** 有效密钥；或登录模式下的管理员会话；或开放模式下本机访问。 */
    private authorized(req: IncomingMessage): boolean {
        const db = Config.getInstance().db;
        const key = authenticateMaintKey(db, req);
        if (key !== 'none') return key !== 'bad';
        if (isAuthEnabled(db)) {
            // 登录模式下必须是 AuthGate 挂上的真实会话（不能退回隐式管理员）。
            const user = (req as IncomingMessage & { user?: { id?: number } }).user;
            return user?.id !== undefined && db.users.getById(user.id)?.role === 'admin';
        }
        return isLoopbackHost(req.headers.host);
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/maint/')) return false;
        if (!this.authorized(req)) {
            sendJson(res, 401, { error: 'unauthorized', hint: '请求头带 Authorization: Bearer <维护密钥>' });
            return true;
        }
        const route = `${req.method ?? 'GET'} ${url.pathname}`;
        try {
            switch (route) {
                case 'GET /api/maint/help':
                    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
                    res.end(MAINT_HELP);
                    return true;
                case 'GET /api/maint/status':
                    sendJson(res, 200, await this.status());
                    return true;
                case 'GET /api/maint/logs':
                    this.logs(url, res);
                    return true;
                case 'POST /api/maint/adb':
                    await this.adbAction(req, res);
                    return true;
                case 'POST /api/maint/restart':
                    this.restart(res);
                    return true;
                case 'GET /api/maint/key':
                    sendJson(res, 200, maintKeyInfo(Config.getInstance().db));
                    return true;
                case 'POST /api/maint/key': {
                    const key = rotateMaintKey(Config.getInstance().db);
                    log.info('维护 API 密钥已重新生成');
                    sendJson(res, 200, { ok: true, key, ...maintKeyInfo(Config.getInstance().db) });
                    return true;
                }
                case 'DELETE /api/maint/key':
                    revokeMaintKey(Config.getInstance().db);
                    log.info('维护 API 密钥已停用');
                    sendJson(res, 200, { ok: true, configured: false });
                    return true;
                default:
                    sendJson(res, 404, { error: 'not found', help: '/api/maint/help' });
                    return true;
            }
        } catch (err) {
            log.warn(`${route} failed: ${(err as Error)?.message ?? String(err)}`);
            if (!res.headersSent) sendJson(res, 500, { error: (err as Error)?.message ?? 'internal error' });
            else sendInternalError(res);
            return true;
        }
    }

    private async status(): Promise<Record<string, unknown>> {
        const db = Config.getInstance().db;
        let adbError: string | undefined;
        let devices: Array<Record<string, string>> = [];
        try {
            const list = await withTimeout(this.adb.devices(), 8000, 'adb devices');
            devices = await Promise.all(
                list.map(async (d) => {
                    const row: Record<string, string> = { serial: d.serial, state: d.state };
                    if (d.state !== 'device') return row;
                    try {
                        const p = await withTimeout(this.adb.getProperties(d.serial), 5000, 'getprop');
                        row['model'] = p['ro.product.model'] ?? '';
                        row['manufacturer'] = p['ro.product.manufacturer'] ?? '';
                        row['android'] = p['ro.build.version.release'] ?? '';
                    } catch {
                        /* 读不到属性也照样列出 */
                    }
                    return row;
                }),
            );
        } catch (err) {
            adbError = (err as Error)?.message ?? String(err);
        }
        const mem = process.memoryUsage();
        return {
            ok: true,
            version: getAppVersion(),
            uiVersion: readUiVersion(),
            node: process.version,
            platform: `${process.platform}-${process.arch}`,
            hostname: os.hostname(),
            pid: process.pid,
            uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
            memoryMB: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
            authEnabled: isAuthEnabled(db),
            logDir: this.logDir,
            devices,
            ...(adbError ? { adbError } : {}),
        };
    }

    private logs(url: URL, res: ServerResponse): void {
        const files = listLogFiles(this.logDir);
        const name = url.searchParams.get('file');
        if (!name) {
            sendJson(res, 200, { ok: true, dir: this.logDir, files });
            return;
        }
        if (!files.some((f) => f.name === name)) {
            sendJson(res, 404, { error: `没有这个日志文件：${name}`, files: files.map((f) => f.name) });
            return;
        }
        const n = Math.min(MAX_LOG_LINES, Math.max(1, Number(url.searchParams.get('lines')) || 200));
        const grep = url.searchParams.get('grep') || undefined;
        sendJson(res, 200, { ok: true, file: name, lines: tailLog(path.join(this.logDir, name), n, grep) });
    }

    private async adbAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const body = await readJsonBody(req);
        const action = String(body['action'] ?? '');
        const device = body['device'];
        const needDevice = (): string | undefined => {
            if (isValidSerial(device)) return device;
            sendJson(res, 400, { error: 'device（adb 序列号）缺失或无效' });
            return undefined;
        };
        const address = typeof body['address'] === 'string' ? body['address'].trim() : '';
        const validAddress = /^[A-Za-z0-9.\-:[\]]{1,100}$/.test(address) && !address.startsWith('-');
        switch (action) {
            case 'devices':
                sendJson(res, 200, { ok: true, devices: await withTimeout(this.adb.devices(), 15_000, 'adb devices') });
                return;
            case 'shell': {
                const serial = needDevice();
                if (!serial) return;
                const command = body['command'];
                if (typeof command !== 'string' || !command.trim() || command.length > 4000) {
                    sendJson(res, 400, { error: 'command 必须是 1~4000 字的字符串' });
                    return;
                }
                const timeoutMs = Math.min(120_000, Math.max(1000, Number(body['timeoutMs']) || 30_000));
                log.info(`adb shell ${serial}: ${command.slice(0, 200)}`);
                sendJson(res, 200, { ok: true, output: await this.adb.shell(serial, command, timeoutMs) });
                return;
            }
            case 'reconnect': {
                const serial = needDevice();
                if (!serial) return;
                log.info(`adb reconnect ${serial}`);
                sendJson(res, 200, { ok: true, output: (await this.adb.reconnect(serial)).trim() });
                return;
            }
            case 'reboot': {
                const serial = needDevice();
                if (!serial) return;
                log.info(`adb reboot ${serial}`);
                await this.adb.shell(serial, 'reboot', 15_000).catch(() => ''); // 手机重启时连接会断，属正常
                sendJson(res, 200, { ok: true });
                return;
            }
            case 'connect':
            case 'disconnect': {
                if (!validAddress) {
                    sendJson(res, 400, { error: 'address 缺失或无效，例如 192.168.1.5:5555' });
                    return;
                }
                const out = action === 'connect' ? await this.adb.connect(address) : await this.adb.disconnect(address);
                log.info(`adb ${action} ${address}: ${out.trim()}`);
                sendJson(res, 200, { ok: true, output: out.trim() });
                return;
            }
            case 'restart-server':
                log.info('adb restart-server');
                await this.adb.killServer();
                await this.adb.startServer();
                sendJson(res, 200, { ok: true, devices: await this.adb.devices() });
                return;
            default:
                sendJson(res, 400, {
                    error: 'action 只能是 devices / shell / reconnect / reboot / connect / disconnect / restart-server',
                });
        }
    }

    private restart(res: ServerResponse): void {
        log.info('restart requested via /api/maint/restart');
        sendJson(res, 200, { ok: true, message: '服务正在重启，约 10 秒后可再访问 /api/maint/status' });
        const restart =
            this.opts.restart ??
            (() => {
                const supervised = Boolean(process.env['DATA_ROOT']);
                if (!supervised) relaunchSelf();
                process.exit(supervised ? 75 : 0);
            });
        setTimeout(async () => {
            try {
                await this.opts.cleanup?.();
            } catch (err) {
                log.warn(`cleanup before restart failed: ${(err as Error)?.message ?? String(err)}`);
            }
            restart();
        }, 200);
    }
}
