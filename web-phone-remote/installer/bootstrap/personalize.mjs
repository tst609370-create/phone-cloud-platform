/**
 * Build a private installer from the public base exe.
 * The invite secret is written only into the output file. It is not printed.
 *
 *   node personalize.mjs --base PhoneRemoteSetup.exe --out /secure/PhoneRemote-one.exe --store ./enrollment.json
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { createInvite, emptyStore, revokeInvite } from './enroll.mjs';

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : '';
}

export function appendInvite(baseBytes, secret) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('bad invite');
    const secretBytes = Buffer.from(secret, 'utf8');
    const tail = Buffer.alloc(2 + 8);
    tail.writeUInt16LE(secretBytes.length, 0);
    tail.write('PRINVITE', 2, 'ascii');
    return Buffer.concat([baseBytes, secretBytes, tail]);
}

function publicPath(file) {
    const lowered = file.replaceAll('\\', '/').toLowerCase();
    return lowered.includes('/artifacts/') || lowered.endsWith('/artifacts') || lowered.includes('/public/');
}

function loadStore(file) {
    if (!existsSync(file)) return emptyStore();
    return JSON.parse(readFileSync(file, 'utf8'));
}

function saveStore(file, store) {
    writeFileSync(file, JSON.stringify(store));
}

if (process.argv[1] && process.argv[1].endsWith('personalize.mjs')) {
    const base = arg('--base');
    const out = arg('--out');
    const storeFile = arg('--store') || './enrollment.json';
    if (!base || !out) {
        console.error('用法: node personalize.mjs --base 公共exe --out 私有exe --store enrollment.json');
        process.exit(2);
    }
    if (publicPath(out)) {
        console.error('拒绝把带邀请的安装包写到公开目录');
        process.exit(1);
    }
    const store = loadStore(storeFile);
    const created = createInvite(store);
    saveStore(storeFile, store);
    try {
        const packed = appendInvite(readFileSync(base), created.secret);
        writeFileSync(out, packed, { mode: 0o600 });
    } catch {
        revokeInvite(store, created.id);
        saveStore(storeFile, store);
        if (existsSync(out)) unlinkSync(out);
        console.error('写入私有安装包失败，这次邀请已作废');
        process.exit(1);
    }
    console.log(`inviteId=${created.id}`);
    console.log(`out=${out}`);
}
