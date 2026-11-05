import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { assignPort } from './assignPort.mjs';

export function hashSecret(secret) {
    return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

export function emptyStore() {
    return { invites: [], devices: [] };
}

export function createInvite(store, targetDeviceId = null) {
    if (targetDeviceId != null && !/^[a-f0-9]{32}$/.test(targetDeviceId)) {
        throw new Error('bad target device');
    }
    const secret = randomBytes(32).toString('hex');
    const id = randomBytes(16).toString('hex');
    store.invites.push({
        id,
        secretHash: hashSecret(secret),
        status: 'pending',
        deviceId: null,
        targetDeviceId: targetDeviceId || null,
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
 * One row per deviceId. The first row is the trusted enrollment. Later rows are
 * untrusted appends and are dropped, including their secrets.
 */
export function canonicalDevices(devices) {
    const order = [];
    const byId = new Map();
    for (const row of devices || []) {
        if (!row || typeof row.deviceId !== 'string') continue;
        if (byId.has(row.deviceId)) continue;
        order.push(row.deviceId);
        byId.set(row.deviceId, {
            deviceId: row.deviceId,
            port: row.port,
            secretHash: row.secretHash,
            inviteId: row.inviteId,
            revoked: row.revoked === true,
        });
    }
    return order.map((id) => byId.get(id));
}

export function bindInvite(store, inviteId, targetDeviceId) {
    if (!/^[a-f0-9]{32}$/.test(inviteId || '')) return { ok: false, error: 'bad invite id' };
    if (!/^[a-f0-9]{32}$/.test(targetDeviceId || '')) return { ok: false, error: 'bad device' };
    store.devices = canonicalDevices(store.devices);
    const invite = store.invites.find((row) => row.id === inviteId);
    if (!invite) return { ok: false, error: 'not found' };
    if (invite.status !== 'pending') return { ok: false, error: 'invite not pending' };
    const device = store.devices.find((row) => row.deviceId === targetDeviceId);
    if (!device) return { ok: false, error: 'device not enrolled' };
    invite.targetDeviceId = targetDeviceId;
    return { ok: true, inviteId: invite.id, targetDeviceId, deviceRevoked: device.revoked === true };
}

export function authorizeDevice(store, deviceId) {
    if (!/^[a-f0-9]{32}$/.test(deviceId || '')) return { ok: false, error: 'bad device' };
    store.devices = canonicalDevices(store.devices);
    const device = store.devices.find((row) => row.deviceId === deviceId);
    if (!device) return { ok: false, error: 'not found' };
    device.revoked = false;
    return { ok: true, deviceId };
}

export function collapseDevices(store) {
    const devices = canonicalDevices(store.devices);
    const changed = devices.length !== store.devices.length;
    store.devices = devices;
    return changed;
}

/**
 * One-time redeem. An ordinary invite only creates a device that is not already
 * enrolled. A recovery invite must already name that device in targetDeviceId,
 * and it rotates the secret only while the device is not revoked.
 * Caller must not await between this function's read and the following save.
 */
export function redeemInvite(store, invite, deviceId) {
    if (!/^[a-f0-9]{64}$/.test(invite || '')) return fail(400, 'bad invite');
    if (!/^[a-f0-9]{32}$/.test(deviceId || '')) return fail(400, 'bad device');
    const inviteRow = store.invites.find((row) => row.secretHash === hashSecret(invite));
    if (!inviteRow || inviteRow.status === 'revoked') return fail(403, 'invite rejected');
    if (inviteRow.status === 'redeemed') return fail(403, 'invite already used');
    store.devices = canonicalDevices(store.devices);
    const existing = store.devices.find((row) => row.deviceId === deviceId);
    const target = inviteRow.targetDeviceId || null;
    if (target) {
        if (target !== deviceId || !existing) return fail(403, 'invite rejected');
        if (existing.revoked === true) return fail(403, 'device revoked');
        return rotate(inviteRow, existing, deviceId);
    }
    if (existing) return fail(403, 'device exists');
    const remotePort = assignPort(
        store.devices.map((row) => ({ deviceId: row.deviceId, port: row.port })),
        deviceId,
    );
    if (remotePort === null) return fail(409, 'ports exhausted');
    const deviceSecret = randomBytes(32).toString('hex');
    inviteRow.status = 'redeemed';
    inviteRow.deviceId = deviceId;
    store.devices.push({
        deviceId,
        port: remotePort,
        secretHash: hashSecret(deviceSecret),
        inviteId: inviteRow.id,
        revoked: false,
    });
    return { ok: true, status: 200, remotePort, deviceSecret };
}

function rotate(inviteRow, existing, deviceId) {
    const deviceSecret = randomBytes(32).toString('hex');
    inviteRow.status = 'redeemed';
    inviteRow.deviceId = deviceId;
    existing.secretHash = hashSecret(deviceSecret);
    existing.inviteId = inviteRow.id;
    return { ok: true, status: 200, remotePort: existing.port, deviceSecret };
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
