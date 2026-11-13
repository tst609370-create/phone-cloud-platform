#!/usr/bin/env node
// 「微信数据」功能授权码签发器（机制，不含私钥）。
// 私钥从环境变量 WECHAT_LICENSE_KEY（base64 的 pkcs8 DER）或 --key-file 指定的文件读取，不入库。
// 配套服务端公钥在 web-phone-remote/src/server/wechat/license.ts。换密钥：重新生成一对，公钥填进 license.ts。
//
// 用法：
//   node tools/make-wechat-license.mjs --days 30 --note 客户A
//   WECHAT_LICENSE_KEY=<base64 pkcs8> node tools/make-wechat-license.mjs --days 90
//   node tools/make-wechat-license.mjs --gen-key      # 首次生成一对密钥（私钥存本地文件，打印公钥）
import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const SCOPE = 'wechat-data';
const args = process.argv.slice(2);
function arg(name, def) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const has = (name) => args.includes(`--${name}`);

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

if (has('gen-key')) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const out = arg('key-file', 'wechat-license.key');
    writeFileSync(out, priv, 'utf8');
    console.log(`私钥已写入 ${out}（务必保密、不要提交）`);
    console.log(`公钥（填进 license.ts 的 TRUSTED_PUBKEY_SPKI_DER_B64）：\n${pub}`);
    process.exit(0);
}

const days = Number(arg('days', '30'));
if (!Number.isFinite(days) || days <= 0) {
    console.error('必须用 --days 指定正整数天数');
    process.exit(1);
}
const keyFile = arg('key-file', null);
const keyB64 = process.env.WECHAT_LICENSE_KEY || (keyFile ? readFileSync(keyFile, 'utf8').trim() : null);
if (!keyB64) {
    console.error('缺少私钥：设置 WECHAT_LICENSE_KEY 或 --key-file <文件>，或先 --gen-key 生成');
    process.exit(1);
}
const privateKey = createPrivateKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'pkcs8' });

const now = Math.floor(Date.now() / 1000);
const payload = {
    v: 1,
    scope: SCOPE,
    iat: now,
    exp: now + Math.round(days * 86400),
    id: arg('note', '') || undefined,
};
const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
const sig = edSign(null, payloadBytes, privateKey);
const code = `${b64url(payloadBytes)}.${b64url(sig)}`;
const expDate = new Date(payload.exp * 1000).toLocaleString('zh-CN', { hour12: false });
console.log(`授权码（有效 ${days} 天，到期 ${expDate}${payload.id ? `，备注 ${payload.id}` : ''}）：`);
console.log(code);
