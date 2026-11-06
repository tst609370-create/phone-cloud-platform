import type net from 'net';
import { AUDIO_DISABLED, AUDIO_ERROR, codecName } from '../common/ScrcpyCodec';
import { FrameReader, type ScrcpyFrame } from './FrameReader';

export interface ScrcpySessionMeta {
    deviceName: string;
    videoCodec: string;
    screenWidth: number;
    screenHeight: number;
    audioCodec: string;
    audioReason?: string;
    videoEncoder?: string;
}

export interface ScrcpyPipeHooks {
    onMetadata(meta: ScrcpySessionMeta): void;
    onVideoFrame(frame: ScrcpyFrame): void;
    onAudioFrame(frame: ScrcpyFrame): void;
    onControl(data: Buffer): void;
    onVideoEnd(): void;
}

const AUDIO_WAIT_REASON = '手机播放声还没有开始，画面继续';

/**
 * Read the video header and forward video immediately. The 4-byte audio codec
 * id is read afterwards so a slow or missing audio capture cannot freeze the
 * picture. Closing the audio socket is avoided: scrcpy treats that as a dead
 * session and would take the video down with it.
 */
export async function pipeScrcpySockets(
    video: net.Socket,
    audio: net.Socket,
    control: net.Socket,
    requestedAudio: boolean,
    audioBlock: string | undefined,
    hooks: ScrcpyPipeHooks,
    audioHeaderTimeoutMs = 8000,
): Promise<void> {
    const { meta: videoMeta, rest } = await readVideoHeader(video);
    let audioCodec = requestedAudio && !audioBlock ? 'pending' : 'disabled';
    let audioReason = audioBlock;
    const publish = () => {
        const meta: ScrcpySessionMeta = { ...videoMeta, audioCodec };
        if (audioReason) meta.audioReason = audioReason;
        hooks.onMetadata(meta);
    };
    publish();

    const videoReader = new FrameReader(video, rest);
    videoReader.onFrame((frame) => hooks.onVideoFrame(frame));
    videoReader.onEnd(() => hooks.onVideoEnd());
    control.on('data', (data: Buffer) => hooks.onControl(data));

    let settled = false;
    const timer = setTimeout(() => {
        if (settled || !requestedAudio) return;
        audioCodec = 'disabled';
        audioReason = audioBlock ?? AUDIO_WAIT_REASON;
        publish();
    }, audioHeaderTimeoutMs);

    try {
        const audioRead = await readExact(audio, 4);
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const codecId = audioRead.data.readUInt32BE(0);
        if (codecId === AUDIO_DISABLED) {
            audioCodec = 'disabled';
            if (requestedAudio) audioReason = audioBlock ?? '手机没有送出可播放的声音';
        } else if (codecId === AUDIO_ERROR) {
            audioCodec = 'error';
            audioReason = '手机音频采集失败';
        } else {
            audioCodec = codecName(codecId);
            audioReason = undefined;
        }
        publish();
        if (audioCodec === 'disabled' || audioCodec === 'error' || audioCodec.startsWith('unknown')) return;
        const audioReader = new FrameReader(audio, audioRead.rest);
        audioReader.onFrame((frame) => hooks.onAudioFrame(frame));
    } catch {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        audioCodec = 'disabled';
        audioReason = requestedAudio ? (audioBlock ?? '播放声中断，画面继续') : undefined;
        publish();
    }
}

function readVideoHeader(socket: net.Socket): Promise<{ meta: Omit<ScrcpySessionMeta, 'audioCodec' | 'audioReason'>; rest: Buffer }> {
    return readExact(socket, 80).then(({ data: videoMeta, rest }) => {
        const deviceNameBytes = videoMeta.subarray(0, 64);
        const nullIdx = deviceNameBytes.indexOf(0);
        const deviceName = deviceNameBytes.subarray(0, nullIdx === -1 ? 64 : nullIdx).toString('utf-8');
        const sessionFlags = videoMeta.readUInt32BE(68);
        if ((sessionFlags & 0x80000000) === 0) {
            throw new Error(
                `scrcpy stream metadata: expected session-packet flag MSB at offset 68, got 0x${sessionFlags.toString(16).padStart(8, '0')}`,
            );
        }
        return {
            meta: {
                deviceName,
                videoCodec: codecName(videoMeta.readUInt32BE(64)),
                screenWidth: videoMeta.readUInt32BE(72),
                screenHeight: videoMeta.readUInt32BE(76),
            },
            rest,
        };
    });
}

function readExact(socket: net.Socket, size: number): Promise<{ data: Buffer; rest: Buffer }> {
    return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const cleanup = () => {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('end', onEnd);
        };
        const onData = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length >= size) {
                cleanup();
                resolve({ data: buffer.subarray(0, size), rest: buffer.subarray(size) });
            }
        };
        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };
        const onEnd = () => onError(new Error('socket closed before the expected bytes'));
        socket.on('data', onData);
        socket.once('error', onError);
        socket.once('end', onEnd);
    });
}
