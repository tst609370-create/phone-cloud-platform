import { createPrivateKey, sign as edSign } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _setTrustedPublicKeyForTest, evaluate } from '../license';
import { WechatApi } from '../WechatApi';

// Throwaway keypair — used ONLY to sign test codes. The production signing key
// is not in the repo; this test swaps the trusted public key via the test seam.
const TEST_PUB = 'MCowBQYDK2VwAyEAEnKS4tj4WZ73QwO40OrXGvYI26WbWb2ErTkPXwdpzjw=';
const TEST_PRIV = 'MC4CAQAwBQYDK2VwBCIEIOFuPW6Uc6Qwm+zFP9W3eZu65c7GUO6KXHYI790alrIt';
const privKey = createPrivateKey({ key: Buffer.from(TEST_PRIV, 'base64'), format: 'der', type: 'pkcs8' });

function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeCode(payload: Record<string, unknown>): string {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    return `${b64url(bytes)}.${b64url(edSign(null, bytes, privKey))}`;
}
const futureExp = () => Math.floor(Date.now() / 1000) + 30 * 86400;
const pastExp = () => Math.floor(Date.now() / 1000) - 60;

beforeEach(() => _setTrustedPublicKeyForTest(TEST_PUB));
afterEach(() => _setTrustedPublicKeyForTest(null));

describe('license.evaluate', () => {
    it('accepts a valid, unexpired, correctly-scoped code', () => {
        const state = evaluate(makeCode({ v: 1, scope: 'wechat-data', iat: 0, exp: futureExp(), id: 'c1' }));
        expect(state.licensed).toBe(true);
        expect(state.daysLeft).toBeGreaterThanOrEqual(29);
        expect(state.id).toBe('c1');
    });
    it('rejects an expired code', () => {
        const state = evaluate(makeCode({ v: 1, scope: 'wechat-data', iat: 0, exp: pastExp() }));
        expect(state.licensed).toBe(false);
        expect(state.reason).toBe('expired');
    });
    it('rejects a tampered signature', () => {
        const code = makeCode({ v: 1, scope: 'wechat-data', iat: 0, exp: futureExp() });
        const broken = `${code.slice(0, -3)}${code.slice(-3) === 'AAA' ? 'BBB' : 'AAA'}`;
        expect(evaluate(broken).licensed).toBe(false);
        expect(evaluate(broken).reason).toBe('bad-sign');
    });
    it('rejects a wrong-scope code', () => {
        const state = evaluate(makeCode({ v: 1, scope: 'other', iat: 0, exp: futureExp() }));
        expect(state.reason).toBe('wrong-scope');
    });
    it('rejects garbage and empty input', () => {
        expect(evaluate('not-a-code').reason).toBe('bad-format');
        expect(evaluate('').reason).toBe('none');
        expect(evaluate(undefined).reason).toBe('none');
    });
});

// --- Minimal fakes for the handler ---
function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    const req = stream as unknown as IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = {};
    return req;
}
function fakeRes(): ServerResponse & { statusCode: number; body: string } {
    const res = {
        statusCode: 0,
        body: '',
        headersSent: false,
        writeHead(status: number) {
            this.statusCode = status;
            this.headersSent = true;
            return this;
        },
        end(chunk?: string) {
            if (chunk) this.body += chunk;
            return this;
        },
    };
    return res as unknown as ServerResponse & { statusCode: number; body: string };
}
function fakeDb() {
    const store = new Map<string, unknown>();
    return {
        appSettings: {
            get: (k: string) => store.get(k),
            set: (k: string, v: unknown) => void store.set(k, v),
        },
    } as unknown as import('../../db/Db').Db;
}

describe('WechatApi license gate', () => {
    beforeEach(() => _setTrustedPublicKeyForTest(TEST_PUB));
    afterEach(() => _setTrustedPublicKeyForTest(null));

    it('passes non-wechat paths through (returns false)', async () => {
        const api = new WechatApi(() => fakeDb(), () => ({ handleWechatRequest: () => true }));
        expect(await api.handle(fakeReq('GET', '/api/devices'), fakeRes())).toBe(false);
    });

    it('locks every feature path when unlicensed', async () => {
        let delegated = false;
        const api = new WechatApi(() => fakeDb(), () => ({
            handleWechatRequest: () => {
                delegated = true;
                return true;
            },
        }));
        const res = fakeRes();
        const handled = await api.handle(fakeReq('GET', '/api/wechat/backups'), res);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error).toBe('locked');
        expect(delegated).toBe(false);
    });

    it('activates a valid code, then delegates feature calls', async () => {
        const db = fakeDb();
        let delegated = false;
        const api = new WechatApi(() => db, () => ({
            handleWechatRequest: () => {
                delegated = true;
                return true;
            },
        }));
        const code = makeCode({ v: 1, scope: 'wechat-data', iat: 0, exp: futureExp() });
        const postRes = fakeRes();
        await api.handle(fakeReq('POST', '/api/wechat/license', { code }), postRes);
        expect(postRes.statusCode).toBe(200);
        expect(JSON.parse(postRes.body).licensed).toBe(true);

        const featRes = fakeRes();
        await api.handle(fakeReq('GET', '/api/wechat/backups'), featRes);
        expect(delegated).toBe(true);
    });

    it('rejects an invalid code on activation (400) and stays locked', async () => {
        const db = fakeDb();
        const api = new WechatApi(() => db, () => ({ handleWechatRequest: () => true }));
        const res = fakeRes();
        await api.handle(fakeReq('POST', '/api/wechat/license', { code: 'bogus' }), res);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).licensed).toBe(false);
        expect(db.appSettings.get('wechatDataLicense')).toBeUndefined();
    });

    it('reports state on GET /license without unlocking', async () => {
        const res = fakeRes();
        await new WechatApi(() => fakeDb(), () => ({ handleWechatRequest: () => true })).handle(
            fakeReq('GET', '/api/wechat/license'),
            res,
        );
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).licensed).toBe(false);
    });
});
