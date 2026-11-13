import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelId } from '../../common/ChannelId';
import { ScrcpyDemuxer } from '../ScrcpyDemuxer';

class FakeWs {
    static OPEN = 1;
    static CONNECTING = 0;
    static last: FakeWs;
    readyState = 1;
    binaryType = '';
    sent: Uint8Array[] = [];
    onmessage?: (ev: { data: ArrayBuffer }) => void;
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor() {
        FakeWs.last = this;
    }
    send(msg: Uint8Array) {
        this.sent.push(new Uint8Array(msg));
    }
    close() {}
}

function videoMsg(size: number): ArrayBuffer {
    const buf = new Uint8Array(1 + 12 + size);
    buf[0] = ChannelId.VIDEO;
    new DataView(buf.buffer).setUint32(9, size);
    return buf.buffer;
}

describe('ScrcpyDemuxer network ACK', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('acknowledges every video frame and echoes the server clock from STATS', () => {
        vi.stubGlobal('WebSocket', FakeWs);
        const demuxer = new ScrcpyDemuxer('ws://x');
        const stats = vi.fn();
        demuxer.onStats(stats);
        const ws = FakeWs.last;
        ws.onmessage!({ data: videoMsg(100) });
        ws.onmessage!({ data: videoMsg(50) });
        expect(ws.sent).toHaveLength(2);
        const last = new DataView(ws.sent[1]!.buffer);
        expect(ws.sent[1]![0]).toBe(ChannelId.ACK);
        expect(last.getFloat64(1)).toBe(113 + 63);
        expect(last.getFloat64(9)).toBe(0);

        const json = new TextEncoder().encode(JSON.stringify({ t: 12345, rttMs: 80 }));
        const msg = new Uint8Array(1 + json.length);
        msg[0] = ChannelId.STATS;
        msg.set(json, 1);
        ws.onmessage!({ data: msg.buffer });
        const echo = new DataView(ws.sent[2]!.buffer);
        expect(echo.getFloat64(1)).toBe(176);
        expect(echo.getFloat64(9)).toBe(12345);
        expect(stats).toHaveBeenCalledWith(expect.objectContaining({ t: 12345, rttMs: 80 }));
    });
});
