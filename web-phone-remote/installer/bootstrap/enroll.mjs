import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { assignPort } from './assignPort.mjs';

export function hashSecret(secret) {
    return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

export function emptyStore() {
    return { invites: [], devices: [] };
}

export function createInvite(store) {
    const secret = randomBytes(32).toString('hex');
    const id = randomBytes(16).toString('hex');
    store.invites.push({
        id,
        secretHash: hashSecret(secret),
        status: 'pending',
        deviceId: null,
    });
    return { id, secret };
}

export function revokeInvite(store, id) {
    const invite = store.invites.find((row) => row.id === id);
    if (!invite) return { ok: false, error: 'not found' };
    if (invite.status === 'redeemed') return { ok: false, error: 'already redeemed' };
    invite.status = 'revoked';
    return { ok: true };
}

export function revokeDevice(store, deviceId) {
    store.devices = canonicalDevices(store.devices);
    const device = store.devices.find((row) => row.deviceId === deviceId);
    if (!device) return { ok: false, error: 'not found' };
    device.revoked = true;
    return { ok: true };
}

/**
 * One row per deviceId. The first row keeps the assigned port. A later duplicate
 * keeps its secret, which is the secret the client was actually given.
 */
export function canonicalDevices(devices) {
    const order = [];
    const byId = new Map();
    for (const row of devices || []) {
        if (!row || typeof row.deviceId !== 'string') continue;
        const current = byId.get(row.deviceId);
        if (!current) {
            order.push(row.deviceId);
            byId.set(row.deviceId, {
                deviceId: row.deviceId,
                port: row.port,
                secretHash: row.secretHash,
                inviteId: row.inviteId,
                revoked: row.revoked === true,
            });
            continue;
        }
        current.secretHash = row.secretHash;
        current.inviteId = row.inviteId;
        current.revoked = row.revoked === true;
    }
    return order.map((id) => byId.get(id));
}

export function collapseDevices(store) {
    const devices = canonicalDevices(store.devices);
    const changed = devices.length !== store.devices.length;
    store.devices = devices;
    return changed;
}

/**
 * One-time redeem. A new unused invite for an existing deviceId rotates that
 * device's secret in place, keeps its port, and drops any duplicate rows.
 * Caller must not await between this function's read and the following save.
 * A redeemed invite cannot be reused, and deviceId alone is never enough.
 */
export function redeemInvite(store, invite, deviceId) {
    if (!/^[a-f0-9]{64}$/.test(invite || '')) return fail(400, 'bad invite');
    if (!/^[a-f0-9]{32}$/.test(deviceId || '')) return fail(400, 'bad device');
    const inviteRow = store.invites.find((row) => row.secretHash === hashSecret(invite));
    if (!inviteRow || inviteRow.status === 'revoked') return fail(403, 'invite rejected');
    if (inviteRow.status === 'redeemed') return fail(403, 'invite already used');
    store.devices = canonicalDevices(store.devices);
    const remotePort = assignPort(
        store.devices.map((row) => ({ deviceId: row.deviceId, port: row.port })),
        deviceId,
    );
    if (remotePort === null) return fail(409, 'ports exhausted');
    const deviceSecret = randomBytes(32).toString('hex');
    inviteRow.status = 'redeemed';
    inviteRow.deviceId = deviceId;
    const next = {
        deviceId,
        port: remotePort,
        secretHash: hashSecret(deviceSecret),
        inviteId: inviteRow.id,
        revoked: false,
    };
    const existing = store.devices.find((row) => row.deviceId === deviceId);
    if (existing) {
        existing.port = remotePort;
        existing.secretHash = next.secretHash;
        existing.inviteId = next.inviteId;
        existing.revoked = false;
    } else {
        store.devices.push(next);
    }
    return { ok: true, status: 200, remotePort, deviceSecret };
}

export function fetchConfig(store, deviceId, deviceSecret) {
    if (!/^[a-f0-9]{32}$/.test(deviceId || '') || !/^[a-f0-9]{64}$/.test(deviceSecret || '')) {
        return fail(403, 'unauthorized');
    }
    const device = canonicalDevices(store.devices).find((row) => row.deviceId === deviceId && row.revoked !== true);
    if (!device) return fail(403, 'unauthorized');
    const got = Buffer.from(hashSecret(deviceSecret), 'hex');
    const want = Buffer.from(device.secretHash, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return fail(403, 'unauthorized');
    return { ok: true, status: 200, remotePort: device.port };
}

export function authorizeFrp(store, body) {
    const op = body?.op;
    const content = body?.content ?? {};
    const deviceId = userOf(content);
    const deviceSecret = secretOf(content);
    const config = fetchConfig(store, deviceId, deviceSecret);
    if (!config.ok) return reject('device not authorized');
    if (op === 'Login') return { reject: false, rejectReason: '', unchange: true };
    if (op === 'NewProxy') {
        const remotePort = Number(content.remotePort ?? content.remote_port);
        if (remotePort !== config.remotePort) return reject('port not assigned to this device');
        return { reject: false, rejectReason: '', unchange: true };
    }
    return reject('unsupported operation');
}

function userOf(content) {
    if (typeof content.user === 'string') return content.user;
    if (content.user && typeof content.user.user === 'string') return content.user.user;
    return '';
}

function secretOf(content) {
    const metas = content.metas || content.user?.metas || {};
    return metas.deviceSecret || metas.device_secret || '';
}

function fail(status, error) {
    return { ok: false, status, error };
}

function reject(reason) {
    return { reject: true, rejectReason: reason, unchange: true };
}
