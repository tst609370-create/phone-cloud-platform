import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createInvite, emptyStore, hashSecret } from './enroll.mjs';

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

test('concurrent register keeps one row per device and rotates only with a new invite', async () => {
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
    const register = (id, invite) =>
        fetch(`${base}/v1/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId: id, invite }),
        });
    const responses = await Promise.all([
        register(deviceId, firstInvite.secret),
        register(deviceId, secondInvite.secret),
        ...others.map((row) => register(row.deviceId, row.invite.secret)),
    ]);
    const bodies = [];
    for (const response of responses) {
        const text = await response.text();
        assert.equal(response.status, 200, text);
        assert.equal(text.includes('token'), false);
        bodies.push(JSON.parse(text));
    }
    assert.equal(bodies[0].remotePort, bodies[1].remotePort);
    const saved = JSON.parse(readFileSync(process.env.PHONE_REMOTE_STORE, 'utf8'));
    const mine = saved.devices.filter((row) => row.deviceId === deviceId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].port, bodies[0].remotePort);
    assert.equal(saved.devices.length, 9);
    assert.equal(new Set(saved.devices.map((row) => row.port)).size, 9);
    assert.equal(saved.invites.every((row) => row.status === 'redeemed'), true);
    let accepted = 0;
    for (const secret of [bodies[0].deviceSecret, bodies[1].deviceSecret]) {
        const config = await fetch(`${base}/v1/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId, deviceSecret: secret }),
        });
        if (config.status === 200) accepted += 1;
        else assert.equal(config.status, 403);
    }
    assert.equal(accepted, 1);
    const replay = await register(deviceId, firstInvite.secret);
    assert.equal(replay.status, 403);
    const duplicate = emptyStore();
    const stale = '1'.repeat(64);
    const latest = '2'.repeat(64);
    duplicate.devices.push(
        { deviceId, port: 10000, secretHash: hashSecret(stale), inviteId: 'old', revoked: false },
        { deviceId, port: 10000, secretHash: hashSecret(latest), inviteId: 'new', revoked: false },
    );
    writeFileSync(process.env.PHONE_REMOTE_STORE, JSON.stringify(duplicate));
    const healed = await fetch(`${base}/v1/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, deviceSecret: latest }),
    });
    assert.equal(healed.status, 200);
    assert.equal((await healed.json()).remotePort, 10000);
    const staleConfig = await fetch(`${base}/v1/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, deviceSecret: stale }),
    });
    assert.equal(staleConfig.status, 403);
    const healedStore = JSON.parse(readFileSync(process.env.PHONE_REMOTE_STORE, 'utf8'));
    assert.equal(healedStore.devices.length, 1);
    await new Promise((resolve) => server.close(resolve));
});
});
