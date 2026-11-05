/**
 * Reference FRP enrollment service. Run this yourself on the machine that
 * already has frps. It reads FRP_TOKEN from the environment and is not started
 * by the public installer.
 *
 *   FRP_TOKEN=... node server.mjs
 *
 * Bind is 127.0.0.1:7100 by default so it is not exposed until you put it
 * behind a protected reverse proxy. Do not commit the token.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { assignPort } from './assignPort.mjs';

const token = process.env.FRP_TOKEN || '';
const storePath = process.env.PHONE_REMOTE_PORT_STORE || './ports.json';
const host = process.env.BIND_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 7100);
const frpServer = process.env.FRP_SERVER || '103.205.240.23';
const frpServerPort = Number(process.env.FRP_SERVER_PORT || 7000);

function load() {
    if (!existsSync(storePath)) return [];
    return JSON.parse(readFileSync(storePath, 'utf8'));
}

function save(rows) {
    writeFileSync(storePath, JSON.stringify(rows, null, 2));
}

const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/register') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
    }
    if (!token) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'FRP_TOKEN is not set on this bootstrap server' }));
        return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
        let body;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'bad json' }));
            return;
        }
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
        if (!/^[a-f0-9]{32}$/.test(deviceId)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'deviceId must be 32 hex chars' }));
            return;
        }
        const rows = load();
        const known = rows.some((row) => row.deviceId === deviceId);
        if (!known && process.env.ENROLL_OPEN !== '1') {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'enrollment closed' }));
            return;
        }
        const remotePort = assignPort(rows, deviceId);
        if (remotePort === null) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: '10000-10100 are all assigned' }));
            return;
        }
        if (!rows.some((row) => row.deviceId === deviceId)) {
            rows.push({ deviceId, port: remotePort });
            save(rows);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
            JSON.stringify({
                serverAddr: frpServer,
                serverPort: frpServerPort,
                remotePort,
                token,
            }),
        );
    });
});

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
    server.listen(port, host, () => {
        console.log(`bootstrap listening on http://${host}:${port} (token is not logged)`);
    });
}

export { server };
