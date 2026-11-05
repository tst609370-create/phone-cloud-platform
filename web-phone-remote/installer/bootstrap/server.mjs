/**
 * Local registration service for https://103.205.240.23:7443 → 127.0.0.1:7100.
 * It does not read or return the FRP shared token.
 *
 *   BIND_HOST=127.0.0.1 PORT=7100 node server.mjs
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { authorizeFrp, emptyStore, fetchConfig, redeemInvite } from './enroll.mjs';

const storePath = process.env.PHONE_REMOTE_STORE || './enrollment.json';
const host = process.env.BIND_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 7100);
const frpServer = process.env.FRP_SERVER || '103.205.240.23';
const frpServerPort = Number(process.env.FRP_SERVER_PORT || 7000);

function load() {
    if (!existsSync(storePath)) return emptyStore();
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.invites) || !Array.isArray(parsed.devices)) return emptyStore();
    return parsed;
}

function save(store) {
    const tmp = `${storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, storePath);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch {
                reject(new Error('bad json'));
            }
        });
        req.on('error', reject);
    });
}

export function requestPathname(url) {
    try {
        const path = new URL(url || '/', 'http://127.0.0.1').pathname;
        if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
        return path || '/';
    } catch {
        return '/';
    }
}

function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
    try {
        const pathname = requestPathname(req.url);
        if (req.method === 'GET' && pathname === '/healthz') {
            send(res, 200, { ok: true });
            return;
        }
        if (req.method === 'POST' && pathname === '/v1/register') {
            const body = await readBody(req);
            const store = load();
            const result = redeemInvite(store, body.invite, body.deviceId);
            if (!result.ok) {
                send(res, result.status, { error: result.error });
                return;
            }
            save(store);
            send(res, 200, {
                serverAddr: frpServer,
                serverPort: frpServerPort,
                remotePort: result.remotePort,
                deviceSecret: result.deviceSecret,
            });
            return;
        }
        if (req.method === 'POST' && pathname === '/v1/config') {
            const body = await readBody(req);
            const result = fetchConfig(load(), body.deviceId, body.deviceSecret);
            if (!result.ok) {
                send(res, result.status, { error: 'unauthorized' });
                return;
            }
            send(res, 200, {
                serverAddr: frpServer,
                serverPort: frpServerPort,
                remotePort: result.remotePort,
            });
            return;
        }
        if (req.method === 'POST' && pathname === '/frp/handler') {
            const body = await readBody(req);
            send(res, 200, authorizeFrp(load(), body));
            return;
        }
        send(res, 404, { error: 'not found' });
    } catch {
        send(res, 400, { error: 'bad request' });
    }
});

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
    server.listen(port, host, () => {
        console.log(`registration listening on http://${host}:${port}`);
    });
}

export { server };
