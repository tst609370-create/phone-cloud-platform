import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeFrp, canonicalDevices, createInvite, emptyStore, fetchConfig, hashSecret, redeemInvite, revokeDevice, revokeInvite } from './enroll.mjs';

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

test('a new invite rotates the same device, keeps its port, and revokes the old secret', () => {
    const store = emptyStore();
    const deviceId = 'a'.repeat(32);
    const firstInvite = createInvite(store);
    const first = redeemInvite(store, firstInvite.secret, deviceId);
    assert.equal(first.remotePort, 10000);
    const secondInvite = createInvite(store);
    const second = redeemInvite(store, secondInvite.secret, deviceId);
    assert.equal(second.ok, true);
    assert.equal(second.remotePort, 10000);
    assert.notEqual(second.deviceSecret, first.deviceSecret);
    assert.equal(store.devices.filter((row) => row.deviceId === deviceId).length, 1);
    assert.equal(store.devices.length, 1);
    assert.equal(fetchConfig(store, deviceId, first.deviceSecret).status, 403);
    assert.equal(fetchConfig(store, deviceId, second.deviceSecret).remotePort, 10000);
    assert.equal(redeemInvite(store, firstInvite.secret, deviceId).status, 403);
    assert.equal(redeemInvite(store, secondInvite.secret, deviceId).status, 403);
    const other = redeemInvite(store, createInvite(store).secret, 'b'.repeat(32));
    assert.equal(other.remotePort, 10001);
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

test('duplicate rows from an older redeem honor the latest secret until a new invite collapses them', () => {
    const store = emptyStore();
    const deviceId = 'c'.repeat(32);
    const oldSecret = '1'.repeat(64);
    const newSecret = '2'.repeat(64);
    store.devices.push(
        { deviceId, port: 10000, secretHash: hashSecret(oldSecret), inviteId: 'old', revoked: false },
        { deviceId, port: 10000, secretHash: hashSecret(newSecret), inviteId: 'new', revoked: false },
    );
    assert.equal(fetchConfig(store, deviceId, oldSecret).status, 403);
    assert.equal(fetchConfig(store, deviceId, newSecret).remotePort, 10000);
    assert.equal(canonicalDevices(store.devices).length, 1);
    const rotated = redeemInvite(store, createInvite(store).secret, deviceId);
    assert.equal(rotated.remotePort, 10000);
    assert.equal(store.devices.length, 1);
    assert.equal(fetchConfig(store, deviceId, newSecret).status, 403);
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
