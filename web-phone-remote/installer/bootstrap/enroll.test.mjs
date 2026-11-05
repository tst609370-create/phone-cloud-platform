import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeFrp, createInvite, emptyStore, fetchConfig, redeemInvite, revokeDevice, revokeInvite } from './enroll.mjs';

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
