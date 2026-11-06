import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEC_ID } from '../../common/ScrcpyCodec';
import { pipeScrcpySockets, type ScrcpySessionMeta } from '../scrcpyMedia';

const open: net.Server[] = [];

afterEach(() => {
    for (const server of open) server.close();
    open.length = 0;
});

function pair(): Promise<[net.Socket, net.Socket]> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        open.push(server);
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as net.AddressInfo).port;
            const client = net.connect(port, '127.0.0.1');
            server.once('connection', (peer) => resolve([client, peer]));
            client.once('error', reject);
        });
    });
}

function videoHeader(): Buffer {
    const buf = Buffer.alloc(80);
    buf.write('Mi10');
    buf.writeUInt32BE(CODEC_ID.H264, 64);
    buf.writeUInt32BE(0x80000000, 68);
    buf.writeUInt32BE(1080, 72);
    buf.writeUInt32BE(2400, 76);
    return buf;
}

function videoFrame(): Buffer {
    const data = Buffer.from([9, 8, 7, 6]);
    const header = Buffer.alloc(12);
    header.writeBigUInt64BE(1000n, 0);
    header.writeUInt32BE(data.length, 8);
    return Buffer.concat([header, data]);
}

describe('audio enable does not hold the video', () => {
    it('forwards a video frame before the audio codec id arrives', async () => {
        const [video, videoPeer] = await pair();
        const [audio, audioPeer] = await pair();
        const [control, controlPeer] = await pair();
        const metas: ScrcpySessionMeta[] = [];
        let videoFrames = 0;
        const done = pipeScrcpySockets(video, audio, control, true, undefined, {
            onMetadata: (meta) => metas.push(meta),
            onVideoFrame: () => {
                videoFrames += 1;
            },
            onAudioFrame: () => undefined,
            onControl: () => undefined,
            onVideoEnd: () => undefined,
        }, 1000);
        videoPeer.write(Buffer.concat([videoHeader(), videoFrame()]));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(videoFrames).toBe(1);
        expect(metas[0]?.videoCodec).toBe('h264');
        expect(metas[0]?.audioCodec).toBe('pending');
        expect(controlPeer.readyState).toBe('open');
        audioPeer.write(Buffer.from([0x6f, 0x70, 0x75, 0x73]));
        await done;
        expect(metas.at(-1)?.audioCodec).toBe('opus');
        videoPeer.destroy();
        audioPeer.destroy();
        controlPeer.destroy();
    });

    it('keeps the video when the phone disables audio', async () => {
        const [video, videoPeer] = await pair();
        const [audio, audioPeer] = await pair();
        const [control, controlPeer] = await pair();
        const metas: ScrcpySessionMeta[] = [];
        let ended = false;
        const done = pipeScrcpySockets(video, audio, control, true, undefined, {
            onMetadata: (meta) => metas.push(meta),
            onVideoFrame: () => undefined,
            onAudioFrame: () => undefined,
            onControl: () => undefined,
            onVideoEnd: () => {
                ended = true;
            },
        }, 1000);
        videoPeer.write(Buffer.concat([videoHeader(), videoFrame()]));
        audioPeer.write(Buffer.from([0, 0, 0, 1]));
        await done;
        expect(ended).toBe(false);
        expect(metas.at(-1)?.audioCodec).toBe('error');
        expect(metas.at(-1)?.audioReason).toContain('采集失败');
        expect(video.destroyed).toBe(false);
        videoPeer.destroy();
        audioPeer.destroy();
        controlPeer.destroy();
    });
});
