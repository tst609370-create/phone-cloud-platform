import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Db } from '../db/Db';
import { readJsonBody } from '../api/utils';
import { evaluate, type LicenseState } from './license';

/**
 * 「微信数据」功能的 API 入口 + 离线时间锁。
 *
 * 真正的备份/恢复实现是一份预编译的独立模块 `wechat-api.cjs`（仓库 vendor/，构建时拷到 dist 根，
 * 运行时按 __dirname 动态 require），对外暴露 `handleWechatRequest(req,res):boolean`。
 * 这个类包在它前面：
 *   - `GET  /api/wechat/license`  读授权状态（未授权也可访问，给界面判断锁没锁）
 *   - `POST /api/wechat/license`  提交授权码；验签 + 查有效期，通过才存进 app_settings
 *   - 其它 `/api/wechat/*`        没有有效授权一律 403 locked，有授权才转给预编译模块
 *
 * 授权码是本机「授权软件」用私钥签发的，带到期时间；到期后这里自动判定过期、功能上锁。
 * 验签逻辑见 ./license.ts，私钥不入库。
 */

const LICENSE_SETTING_KEY = 'wechatDataLicense';

// Webpack escape hatch: compiles to the real runtime `require`, so the dynamic
// path is resolved at run time against dist/ (where the build drops the .cjs),
// not bundled. Falls back to the normal require under ts-node/vitest.
declare const __non_webpack_require__: NodeRequire | undefined;
type VendorModule = { handleWechatRequest: (req: IncomingMessage, res: ServerResponse) => boolean };
let vendor: VendorModule | null = null;
function loadVendor(): VendorModule {
    if (!vendor) {
        const nodeRequire = typeof __non_webpack_require__ === 'function' ? __non_webpack_require__ : require;
        vendor = nodeRequire(path.join(__dirname, 'wechat-api.cjs')) as VendorModule;
    }
    return vendor;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
}

export class WechatApi {
    private readonly vendorLoader: () => VendorModule;
    constructor(
        private readonly getDb: () => Db,
        vendorLoader: () => VendorModule = loadVendor,
    ) {
        this.vendorLoader = vendorLoader;
    }

    private currentState(): LicenseState {
        const code = this.getDb().appSettings.get(LICENSE_SETTING_KEY);
        return evaluate(typeof code === 'string' ? code : undefined);
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        if (!pathname.startsWith('/api/wechat/')) return false;

        // --- 授权状态 / 激活：锁着也能用 ---
        if (pathname === '/api/wechat/license') {
            if (req.method === 'GET') {
                sendJson(res, 200, this.currentState());
                return true;
            }
            if (req.method === 'POST') {
                let code = '';
                try {
                    const body = await readJsonBody(req);
                    code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
                } catch {
                    sendJson(res, 400, { ...evaluate(undefined), error: 'bad-request' });
                    return true;
                }
                const state = evaluate(code);
                if (!state.licensed) {
                    sendJson(res, 400, { ...state, error: 'rejected' });
                    return true;
                }
                this.getDb().appSettings.set(LICENSE_SETTING_KEY, code.trim());
                sendJson(res, 200, state);
                return true;
            }
            sendJson(res, 405, { error: 'method-not-allowed' });
            return true;
        }

        // --- 其它接口：先过时间锁 ---
        const state = this.currentState();
        if (!state.licensed) {
            sendJson(res, 403, { error: 'locked', ...state });
            return true;
        }

        let handled = false;
        try {
            handled = this.vendorLoader().handleWechatRequest(req, res);
        } catch (error) {
            if (!res.headersSent) {
                sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
            }
            return true;
        }
        if (!handled && !res.headersSent) {
            sendJson(res, 404, { error: 'not-found' });
        }
        return true;
    }
}
