import type { IncomingMessage, ServerResponse } from 'http';

export type RealtimeTopic = 'devices' | 'rentals';

export class RealtimeEventsApi {
    private static readonly clients = new Set<ServerResponse>();

    public static publish(topic: RealtimeTopic): void {
        const payload = `event: update\ndata: ${JSON.stringify({ topic })}\n\n`;
        for (const client of this.clients) {
            try {
                client.write(payload);
            } catch {
                this.clients.delete(client);
            }
        }
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (req.method !== 'GET' || pathname !== '/api/events') return false;

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\nevent: ready\ndata: {}\n\n');
        RealtimeEventsApi.clients.add(res);
        req.socket.setKeepAlive(true);
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
        req.once('close', () => {
            clearInterval(heartbeat);
            RealtimeEventsApi.clients.delete(res);
        });
        return true;
    }
}
