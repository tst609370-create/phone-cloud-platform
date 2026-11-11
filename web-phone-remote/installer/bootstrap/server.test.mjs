import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { bindInvite, createInvite, emptyStore, hashSecret, revokeDevice } from './enroll.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'reg-'));
process.env.PHONE_REMOTE_STORE = path.join(dir, 'enrollment.json');
process.env.PORT = '0';
const { requestPathname, server } = await import('./server.mjs');

test('routes ignore query strings', () => {
    assert.equal(requestPathname('/frp/handler?op=Login'), '/frp/handler');
    assert.equal(requestPathname('/healthz?ready=1'), '/healthz');
    assert.equal(requestPathname('/v1/register/'), '/v1/register');
});

describe('registration http', { concurrency: false }, () => {
test('oversized bodies are refused without buffering them', async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invite: 'x'.repeat(64 * 1024) }),
    });
    assert.equal(res.status, 413);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
});
test('healthz and plugin query do not 404, and empty register is not 503', async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/healthz?ready=1`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const plugin = await fetch(`${base}/frp/handler?op=Login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'NewProxy', content: { user: 'nope', remotePort: 10000 } }),
    });
    assert.equal(plugin.status, 200);
    assert.equal((await plugin.json()).reject, true);
    const register = await fetch(`${base}/v1/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
    const text = await register.text();
    assert.equal(register.status, 400);
    assert.notEqual(register.status, 503);
    assert.equal(text.includes('token'), false);
    await new Promise((resolve) => server.close(resolve));
});

test('concurrent register, recovery, and duplicate rows stay inside the v2 request', async () => {
    const store = emptyStore();
    const deviceId = 'a'.repeat(32);
    const firstInvite = createInvite(store);
    const secondInvite = createInvite(store);
    const others = [];
    for (let i = 0; i < 8; i++) {
        others.push({ deviceId: `${i + 1}`.padStart(32, '0'), invite: createInvite(store) });
    }
    writeFileSync(process.env.PHONE_REMOTE_STORE, JSON.stringify(store));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const register = (id, invite, extra = {}) =>
        fetch(`${base}/v1/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId: id, invite, ...extra }),
        });
    const responses = await Promise.all([
        register(deviceId, firstInvite.secret),
        register(deviceId, secondInvite.secret),
        ...others.map((row) => register(row.deviceId, row.invite.secret)),
    ]);
    const accepted = [];
    let rejected = 0;
    for (const response of responses) {
        const text = await response.text();
        assert.equal(text.includes('token'), false);
        if (response.status === 200) {
            const body = JSON.parse(text);
            assert.deepEqual(Object.keys(body).sort(), ['deviceSecret', 'remotePort', 'serverAddr', 'serverPort']);
            accepted.push(body);
        } else {
            assert.equal(response.status, 403);
            rejected += 1;
        }
    }
    assert.equal(rejected, 1);
    assert.equal(accepted.length, 9);
    const saved = JSON.parse(readFileSync(process.env.PHONE_REMOTE_STORE, 'utf8'));
    assert.equal(saved.devices.length, 9);
    assert.equal(new Set(saved.devices.map((row) => row.port)).size, 9);
    const owner = saved.devices.find((row) => row.deviceId === deviceId);
    const pending = saved.invites.filter((row) => row.status === 'pending');
    assert.equal(pending.length, 1);
    const pendingInvite = [firstInvite, secondInvite].find((row) => row.id === pending[0].id);
    const attack = await register(deviceId, pendingInvite.secret, { targetDeviceId: deviceId });
    assert.equal(attack.status, 403);
    const afterAttack = JSON.parse(readFileSync(process.env.PHONE_REMOTE_STORE, 'utf8'));
    assert.equal(afterAttack.invites.find((row) => row.id === pendingInvite.id).status, 'pending');
    assert.equal(afterAttack.invites.find((row) => row.id === pendingInvite.id).targetDeviceId, null);
    const ownerConfig = await fetch(`${base}/v1/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            deviceId,
            deviceSecret: accepted.find((row) => row.remotePort === owner.port).deviceSecret,
        }),
    });
    assert.equal(ownerConfig.status, 200);
    const firstSecret = '1'.repeat(64);
    const attackSecret = '2'.repeat(64);
    const duplicate = emptyStore();
    duplicate.devices.push(
        { deviceId, port: 10000, secretHash: hashSecret(firstSecret), inviteId: 'old', revoked: false },
        { deviceId, port: 10007, secretHash: hashSecret(attackSecret), inviteId: 'attack', revoked: false },
    );
    const recovery = createInvite(duplicate);
    assert.equal(bindInvite(duplicate, recovery.id, deviceId).ok, true);
    writeFileSync(process.env.PHONE_REMOTE_STORE, JSON.stringify(duplicate));
    const attacked = await fetch(`${base}/v1/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, deviceSecret: attackSecret }),
    });
    assert.equal(attacked.status, 403);
    const kept = await fetch(`${base}/v1/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, deviceSecret: firstSecret }),
    });
    assert.equal(kept.status, 200);
    assert.equal((await kept.json()).remotePort, 10000);
    const collapsed = JSON.parse(readFileSync(process.env.PHONE_REMOTE_STORE, 'utf8'));
    assert.equal(collapsed.devices.length, 1);
    assert.equal(collapsed.devices[0].port, 10000);
    const rotated = await register(deviceId, recovery.secret);
    const rotatedText = await rotated.text();
    assert.equal(rotated.status, 200, rotatedText);
    assert.equal(JSON.parse(rotatedText).remotePort, 10000);
    assert.equal(rotatedText.includes('token'), false);
    const oldNow = await fetch(`${base}/v1/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, deviceSecret: firstSecret }),
    });
    assert.equal(oldNow.status, 403);
    revokeDevice(collapsed, deviceId);
    const blocked = createInvite(collapsed, deviceId);
    writeFileSync(process.env.PHONE_REMOTE_STORE, JSON.stringify(collapsed));
    const revived = await register(deviceId, blocked.secret);
    assert.equal(revived.status, 403);
    const stillRevoked = JSON.parse(readFileSync(process.env.PHONE_REMOTE_STORE, 'utf8'));
    assert.equal(stillRevoked.devices[0].revoked, true);
    assert.equal(stillRevoked.invites.find((row) => row.id === blocked.id).status, 'pending');
    await new Promise((resolve) => server.close(resolve));
});
});
