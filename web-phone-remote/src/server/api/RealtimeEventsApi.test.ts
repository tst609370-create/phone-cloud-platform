import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeEventsApi } from './RealtimeEventsApi';

describe('RealtimeEventsApi', () => {
    it('pushes updates to connected clients and removes closed clients', async () => {
        const req = Object.assign(new EventEmitter(), {
            method: 'GET',
            url: '/api/events',
            socket: { setKeepAlive: vi.fn() },
        });
        const res = { writeHead: vi.fn(), write: vi.fn() };

        expect(await new RealtimeEventsApi().handle(req as any, res as any)).toBe(true);
        RealtimeEventsApi.publish('rentals');
        expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"topic":"rentals"'));

        const writes = res.write.mock.calls.length;
        req.emit('close');
        RealtimeEventsApi.publish('devices');
        expect(res.write).toHaveBeenCalledTimes(writes);
    });
});
