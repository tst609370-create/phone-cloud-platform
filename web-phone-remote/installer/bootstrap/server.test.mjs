import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(path.join(tmpdir(), 'reg-'));
process.env.PHONE_REMOTE_STORE = path.join(dir, 'enrollment.json');
process.env.PORT = '0';
const { requestPathname, server } = await import('./server.mjs');

test('routes ignore query strings', () => {
    assert.equal(requestPathname('/frp/handler?op=Login'), '/frp/handler');
    assert.equal(requestPathname('/healthz?ready=1'), '/healthz');
    assert.equal(requestPathname('/v1/register/'), '/v1/register');
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
