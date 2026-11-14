import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Db } from '../db/Db';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import type { User } from '../db/UserStore';

/**
 * 维护 API 密钥（给 AI / 脚本用）。只在 app_settings 里存 sha256，明文只在生成时返回一次。
 * 请求带 `Authorization: Bearer <密钥>` 或 `X-Maint-Key: <密钥>`，校验通过即以管理员身份访问全部 /api/*。
 */
export const MAINT_KEY_SETTING = 'maintApiKey';
export const MAINT_KEY_PREFIX = 'pck_';

interface StoredKey {
    hash: string;
    createdAt: number;
    hint: string;
}

function sha256(text: string): Buffer {
    return createHash('sha256').update(text, 'utf8').digest();
}

function stored(db: Db): StoredKey | undefined {
    const v = db.appSettings.get(MAINT_KEY_SETTING) as StoredKey | null | undefined;
    return v && typeof v.hash === 'string' ? v : undefined;
}

export function maintKeyInfo(db: Db): { configured: boolean; createdAt?: number; hint?: string } {
    const k = stored(db);
    return k ? { configured: true, createdAt: k.createdAt, hint: k.hint } : { configured: false };
}

/** 生成新密钥（旧的立即失效），返回明文。 */
export function rotateMaintKey(db: Db, now = Date.now()): string {
    const key = MAINT_KEY_PREFIX + randomBytes(32).toString('base64url');
    db.appSettings.set(MAINT_KEY_SETTING, {
        hash: sha256(key).toString('hex'),
        createdAt: now,
        hint: `${key.slice(0, 8)}…${key.slice(-4)}`,
    } satisfies StoredKey);
    return key;
}

export function revokeMaintKey(db: Db): void {
    db.appSettings.set(MAINT_KEY_SETTING, null);
}

/** 请求里带的密钥（没有就是 undefined）。不接受 URL 参数，免得进访问日志。 */
export function presentedMaintKey(req: IncomingMessage): string | undefined {
    const custom = req.headers['x-maint-key'];
    if (typeof custom === 'string' && custom.trim()) return custom.trim();
    const auth = req.headers['authorization'];
    if (typeof auth === 'string') {
        const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
        if (m) return m[1];
    }
    return undefined;
}

export function isValidMaintKey(db: Db, key: string): boolean {
    const k = stored(db);
    if (!k || !key.startsWith(MAINT_KEY_PREFIX)) return false;
    const want = Buffer.from(k.hash, 'hex');
    const got = sha256(key);
    return want.length === got.length && timingSafeEqual(want, got);
}

/** 密钥对应的身份：第一个启用的管理员（没有就用内置管理员）。 */
export function maintKeyUser(db: Db): User | undefined {
    return db.users.list().find((u) => u.role === 'admin' && !u.disabled) ?? db.users.getById(IMPLICIT_ADMIN_ID);
}

/**
 * 校验请求里的密钥。'none' = 没带；'bad' = 带了但不对；否则返回管理员身份。
 */
export function authenticateMaintKey(db: Db, req: IncomingMessage): 'none' | 'bad' | User {
    const key = presentedMaintKey(req);
    if (key === undefined) return 'none';
    if (!isValidMaintKey(db, key)) return 'bad';
    return maintKeyUser(db) ?? 'bad';
}
