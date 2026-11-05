import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('healthz is ok and register does not return 503 or a token', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reg-'));
    process.env.PHONE_REMOTE_STORE = path.join(dir, 'enrollment.json');
    process.env.PORT = '0';
    const { server } = await import('./server.mjs');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const register = await fetch(`http://127.0.0.1:${port}/v1/register`, {
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
