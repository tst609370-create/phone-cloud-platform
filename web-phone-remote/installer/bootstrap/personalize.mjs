/**
 * Build a private installer from the public base exe.
 * The invite secret is written only into the output file. It is not printed.
 *
 *   node personalize.mjs --base PhoneRemoteSetup.exe --out /secure/PhoneRemote-one.exe --store ./enrollment.json
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { authorizeDevice, bindInvite, canonicalDevices, createInvite, emptyStore, revokeInvite } from './enroll.mjs';

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
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, file);
}

if (process.argv[1] && process.argv[1].endsWith('personalize.mjs')) {
    const base = arg('--base');
    const out = arg('--out');
    const storeFile = arg('--store') || './enrollment.json';
    const bindId = arg('--bind-invite');
    const authorizeId = arg('--authorize-device');
    const target = arg('--target-device');
    if (bindId || authorizeId) {
        if (base || out) {
            console.error('绑定和授权不生成安装包');
            process.exit(2);
        }
        const store = loadStore(storeFile);
        let authorized = null;
        let bound = null;
        if (authorizeId) {
            authorized = authorizeDevice(store, authorizeId);
            if (!authorized.ok) {
                console.error(authorized.error);
                process.exit(1);
            }
        }
        if (bindId) {
            if (!target) {
                console.error('绑定恢复邀请需要 --target-device');
                process.exit(2);
            }
            bound = bindInvite(store, bindId, target);
            if (!bound.ok) {
                console.error(bound.error);
                process.exit(1);
            }
        }
        saveStore(storeFile, store);
        if (authorized) {
            console.log(`deviceId=${authorized.deviceId}`);
            console.log('authorized=1');
        }
        if (bound) {
            if (bound.deviceRevoked) console.error('设备仍处于撤销状态，恢复邀请不会使它复活');
            console.log(`inviteId=${bound.inviteId}`);
            console.log(`targetDeviceId=${bound.targetDeviceId}`);
        }
        process.exit(0);
    }
    if (!base || !out) {
        console.error('用法: node personalize.mjs --base 公共exe --out 私有exe --store enrollment.json [--target-device 设备ID]');
        process.exit(2);
    }
    if (publicPath(out)) {
        console.error('拒绝把带邀请的安装包写到公开目录');
        process.exit(1);
    }
    const store = loadStore(storeFile);
    if (target) {
        if (!/^[a-f0-9]{32}$/.test(target)) {
            console.error('bad target device');
            process.exit(2);
        }
        const enrolled = canonicalDevices(store.devices).find((row) => row.deviceId === target);
        if (!enrolled) {
            console.error('target device not enrolled');
            process.exit(1);
        }
        if (enrolled.revoked === true) console.error('设备仍处于撤销状态，恢复邀请不会使它复活');
    }
    const created = createInvite(store, target || null);
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
