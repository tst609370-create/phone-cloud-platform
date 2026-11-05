import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeDevice, authorizeFrp, bindInvite, canonicalDevices, createInvite, emptyStore, fetchConfig, hashSecret, redeemInvite, revokeDevice, revokeInvite } from './enroll.mjs';

test('unknown device id cannot enroll or fetch config', () => {
    const store = emptyStore();
    const deviceId = 'a'.repeat(32);
    assert.equal(redeemInvite(store, 'b'.repeat(64), deviceId).ok, false);
    assert.equal(fetchConfig(store, deviceId, 'c'.repeat(64)).status, 403);
});

test('invite is one-time, bound to one device, and revocable before use', () => {
    const store = emptyStore();
    const created = createInvite(store);
    assert.equal(revokeInvite(store, created.id).ok, true);
    assert.equal(redeemInvite(store, created.secret, 'd'.repeat(32)).status, 403);

    const live = createInvite(store);
    const deviceA = 'a'.repeat(32);
    const deviceB = 'b'.repeat(32);
    const first = redeemInvite(store, live.secret, deviceA);
    assert.equal(first.ok, true);
    assert.equal(first.remotePort, 10000);
    assert.equal(redeemInvite(store, live.secret, deviceA).status, 403);
    assert.equal(redeemInvite(store, live.secret, deviceB).status, 403);
    assert.equal(fetchConfig(store, deviceA, '0'.repeat(64)).status, 403);
    const again = fetchConfig(store, deviceA, first.deviceSecret);
    assert.equal(again.remotePort, 10000);
    assert.equal(JSON.stringify(again).includes('token'), false);
    assert.equal(JSON.stringify(first).includes('"token"'), false);
});

test('two new devices get different ports and a revoked device loses authorization', () => {
    const store = emptyStore();
    const a = redeemInvite(store, createInvite(store).secret, '1'.repeat(32));
    const b = redeemInvite(store, createInvite(store).secret, '2'.repeat(32));
    assert.notEqual(a.remotePort, b.remotePort);
    assert.equal(revokeDevice(store, '2'.repeat(32)).ok, true);
    assert.equal(fetchConfig(store, '2'.repeat(32), b.deviceSecret).status, 403);
    const login = authorizeFrp(store, {
        op: 'Login',
        content: { user: '1'.repeat(32), metas: { deviceSecret: a.deviceSecret } },
    });
    assert.equal(login.reject, false);
    const wrongPort = authorizeFrp(store, {
        op: 'NewProxy',
        content: { user: { user: '1'.repeat(32), metas: { deviceSecret: a.deviceSecret } }, remotePort: b.remotePort },
    });
    assert.equal(wrongPort.reject, true);
    const rightPort = authorizeFrp(store, {
        op: 'NewProxy',
        content: { user: '1'.repeat(32), metas: { deviceSecret: a.deviceSecret }, remotePort: a.remotePort },
    });
    assert.equal(rightPort.reject, false);
    const tokenOnly = authorizeFrp(store, {
        op: 'NewProxy',
        content: { user: '1'.repeat(32), metas: {}, remotePort: a.remotePort },
    });
    assert.equal(tokenOnly.reject, true);
});

test('an ordinary invite cannot rotate another device or steal its port', () => {
    const store = emptyStore();
    const owner = 'a'.repeat(32);
    const stranger = 'b'.repeat(32);
    const first = redeemInvite(store, createInvite(store).secret, owner);
    const attack = createInvite(store);
    const stolen = redeemInvite(store, attack.secret, owner);
    assert.equal(stolen.status, 403);
    assert.equal(store.invites.find((row) => row.id === attack.id).status, 'pending');
    assert.equal(store.devices.filter((row) => row.deviceId === owner).length, 1);
    assert.equal(fetchConfig(store, owner, first.deviceSecret).remotePort, 10000);
    const created = redeemInvite(store, attack.secret, stranger);
    assert.equal(created.ok, true);
    assert.equal(created.remotePort, 10001);
    assert.equal(fetchConfig(store, owner, first.deviceSecret).remotePort, 10000);
});

test('a bound recovery invite rotates only its target while the device is active', () => {
    const store = emptyStore();
    const deviceId = 'a'.repeat(32);
    const otherId = 'b'.repeat(32);
    const first = redeemInvite(store, createInvite(store).secret, deviceId);
    redeemInvite(store, createInvite(store).secret, otherId);
    const recovery = createInvite(store, deviceId);
    const wrong = redeemInvite(store, recovery.secret, otherId);
    assert.equal(wrong.status, 403);
    assert.equal(store.invites.find((row) => row.id === recovery.id).status, 'pending');
    const second = redeemInvite(store, recovery.secret, deviceId);
    assert.equal(second.ok, true);
    assert.equal(second.remotePort, 10000);
    assert.notEqual(second.deviceSecret, first.deviceSecret);
    assert.equal(store.devices.filter((row) => row.deviceId === deviceId).length, 1);
    assert.equal(fetchConfig(store, deviceId, first.deviceSecret).status, 403);
    assert.equal(fetchConfig(store, deviceId, second.deviceSecret).remotePort, 10000);
    const login = authorizeFrp(store, {
        op: 'Login',
        content: { user: deviceId, metas: { deviceSecret: first.deviceSecret } },
    });
    assert.equal(login.reject, true);
    const proxy = authorizeFrp(store, {
        op: 'NewProxy',
        content: { user: deviceId, metas: { deviceSecret: second.deviceSecret }, remotePort: 10000 },
    });
    assert.equal(proxy.reject, false);
});

test('a revoked device stays revoked even when a recovery invite names it', () => {
    const store = emptyStore();
    const deviceId = 'c'.repeat(32);
    const first = redeemInvite(store, createInvite(store).secret, deviceId);
    assert.equal(revokeDevice(store, deviceId).ok, true);
    const recovery = createInvite(store, deviceId);
    const attempt = redeemInvite(store, recovery.secret, deviceId);
    assert.equal(attempt.status, 403);
    assert.equal(store.devices.find((row) => row.deviceId === deviceId).revoked, true);
    assert.equal(store.invites.find((row) => row.id === recovery.id).status, 'pending');
    assert.equal(fetchConfig(store, deviceId, first.deviceSecret).status, 403);
    assert.equal(authorizeDevice(store, deviceId).ok, true);
    const restored = redeemInvite(store, recovery.secret, deviceId);
    assert.equal(restored.remotePort, 10000);
    assert.equal(fetchConfig(store, deviceId, first.deviceSecret).status, 403);
    assert.equal(fetchConfig(store, deviceId, restored.deviceSecret).remotePort, 10000);
});

test('binding an existing invite recovers that device and duplicate rows keep the first secret', () => {
    const store = emptyStore();
    const deviceId = 'd'.repeat(32);
    const ownerSecret = '1'.repeat(64);
    const attackSecret = '2'.repeat(64);
    store.devices.push(
        { deviceId, port: 10000, secretHash: hashSecret(ownerSecret), inviteId: 'old', revoked: false },
        { deviceId, port: 10000, secretHash: hashSecret(attackSecret), inviteId: 'attack', revoked: false },
    );
    assert.equal(fetchConfig(store, deviceId, attackSecret).status, 403);
    assert.equal(fetchConfig(store, deviceId, ownerSecret).remotePort, 10000);
    assert.equal(canonicalDevices(store.devices)[0].secretHash, hashSecret(ownerSecret));
    const pending = createInvite(store);
    assert.equal(redeemInvite(store, pending.secret, deviceId).status, 403);
    assert.equal(store.invites.find((row) => row.id === pending.id).status, 'pending');
    assert.equal(bindInvite(store, pending.id, deviceId).ok, true);
    assert.equal(store.devices.length, 1);
    const rotated = redeemInvite(store, pending.secret, deviceId);
    assert.equal(rotated.remotePort, 10000);
    assert.equal(fetchConfig(store, deviceId, ownerSecret).status, 403);
    assert.equal(fetchConfig(store, deviceId, attackSecret).status, 403);
    assert.equal(fetchConfig(store, deviceId, rotated.deviceSecret).remotePort, 10000);
});

test('device id without a new unused invite cannot rotate', () => {
    const store = emptyStore();
    const deviceId = 'd'.repeat(32);
    const invite = createInvite(store);
    const first = redeemInvite(store, invite.secret, deviceId);
    const snapshot = JSON.stringify(store.devices);
    assert.equal(redeemInvite(store, '', deviceId).status, 400);
    assert.equal(redeemInvite(store, 'e'.repeat(64), deviceId).status, 403);
    assert.equal(redeemInvite(store, invite.secret, deviceId).status, 403);
    assert.equal(fetchConfig(store, deviceId, '').status, 403);
    assert.equal(JSON.stringify(store.devices), snapshot);
    assert.equal(fetchConfig(store, deviceId, first.deviceSecret).remotePort, 10000);
});
