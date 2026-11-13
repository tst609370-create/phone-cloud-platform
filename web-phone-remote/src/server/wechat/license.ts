import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * 「微信数据」功能的离线时间锁。
 *
 * 授权码是一段 Ed25519 签名的令牌：`<base64url(payload)>.<base64url(sig)>`。
 * payload 是 JSON：{ v:1, scope:"wechat-data", iat, exp, id? }（时间为秒）。
 * 服务端只内置「公钥」，用来验签 + 查有效期；私钥只在用户本机的「授权软件」里，
 * 不入库、不入仓库。改公钥只改下面这一行（配套私钥一起换）。
 */
const TRUSTED_PUBKEY_SPKI_DER_B64 = 'MCowBQYDK2VwAyEAlf7H+ZR7nupYbp00u3NYAy6jrMt0/DGz46S4f2Fsi74=';

const SCOPE = 'wechat-data';

export type LicenseState = {
    licensed: boolean;
    /** 到期时间（毫秒）。未授权为 0。 */
    expiresMs: number;
    /** 剩余天数（向下取整，过期为 0）。 */
    daysLeft: number;
    /** 授权码里的备注/客户标识（可空）。 */
    id?: string;
    /** 未授权时的原因，给界面展示：none / bad-format / bad-sign / wrong-scope / expired。 */
    reason?: string;
};

export const LOCKED: LicenseState = { licensed: false, expiresMs: 0, daysLeft: 0, reason: 'none' };

let trustedKey: ReturnType<typeof createPublicKey> | null = null;
let trustedKeyB64 = TRUSTED_PUBKEY_SPKI_DER_B64;
function publicKey() {
    if (!trustedKey) {
        trustedKey = createPublicKey({
            key: Buffer.from(trustedKeyB64, 'base64'),
            format: 'der',
            type: 'spki',
        });
    }
    return trustedKey;
}

/** Test seam: swap the trusted public key so tests can sign with a throwaway key. */
export function _setTrustedPublicKeyForTest(derB64: string | null): void {
    trustedKeyB64 = derB64 ?? TRUSTED_PUBKEY_SPKI_DER_B64;
    trustedKey = null;
}

function b64urlDecode(s: string): Buffer {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** 验签并按当前时间判断一段授权码。不碰存储。 */
export function evaluate(code: string | undefined | null, nowMs = Date.now()): LicenseState {
    if (!code || typeof code !== 'string') return { ...LOCKED, reason: 'none' };
    const trimmed = code.trim();
    const dot = trimmed.indexOf('.');
    if (dot <= 0 || dot === trimmed.length - 1) return { ...LOCKED, reason: 'bad-format' };
    const payloadPart = trimmed.slice(0, dot);
    const sigPart = trimmed.slice(dot + 1);

    let sig: Buffer;
    let payloadBytes: Buffer;
    try {
        payloadBytes = b64urlDecode(payloadPart);
        sig = b64urlDecode(sigPart);
    } catch {
        return { ...LOCKED, reason: 'bad-format' };
    }
    if (sig.length !== 64) return { ...LOCKED, reason: 'bad-format' };

    let ok = false;
    try {
        // Ed25519: algorithm must be null; sign over the exact payload bytes.
        ok = cryptoVerify(null, payloadBytes, publicKey(), sig);
    } catch {
        ok = false;
    }
    if (!ok) return { ...LOCKED, reason: 'bad-sign' };

    let payload: { v?: number; scope?: string; iat?: number; exp?: number; id?: string };
    try {
        payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
        return { ...LOCKED, reason: 'bad-format' };
    }
    if (payload.scope !== SCOPE) return { ...LOCKED, reason: 'wrong-scope' };
    const expMs = Number(payload.exp) * 1000;
    if (!Number.isFinite(expMs) || expMs <= 0) return { ...LOCKED, reason: 'bad-format' };
    if (expMs <= nowMs) {
        const expired: LicenseState = { licensed: false, expiresMs: expMs, daysLeft: 0, reason: 'expired' };
        if (payload.id !== undefined) expired.id = payload.id;
        return expired;
    }
    const daysLeft = Math.floor((expMs - nowMs) / 86_400_000);
    const result: LicenseState = { licensed: true, expiresMs: expMs, daysLeft };
    if (payload.id !== undefined) result.id = payload.id;
    return result;
}
