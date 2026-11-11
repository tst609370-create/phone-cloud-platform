import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import WS, { WebSocketServer as WSServer } from 'ws';
import { startHeartbeat } from '../services/WebSocketServer';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

async function setup(autoPong: boolean) {
    const http = createServer();
    const wss = new WSServer({ server: http });
    startHeartbeat(wss, 50);
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const { port } = http.address() as AddressInfo;
    const client = new WS(`ws://127.0.0.1:${port}`, { autoPong });
    await new Promise((r) => client.once('open', r));
    cleanups.push(async () => {
        client.terminate();
        wss.close();
        await new Promise((r) => http.close(r));
    });
    return { wss, client };
}

describe('startHeartbeat', () => {
    it('keeps clients that answer pings', async () => {
        const { client } = await setup(true);
        await new Promise((r) => setTimeout(r, 250));
        expect(client.readyState).toBe(WS.OPEN);
    });

    it('terminates clients that stop answering', async () => {
        const { client } = await setup(false);
        const closed = new Promise((r) => client.once('close', r));
        await closed;
        expect(client.readyState).toBe(WS.CLOSED);
    }, 2000);
});
