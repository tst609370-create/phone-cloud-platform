import { downmixToMono, floatToS16le } from './floatToS16le';

const WORKLET = `
class WsMicCapture extends AudioWorkletProcessor {
    process(inputs) {
        const channels = inputs[0];
        if (!channels || !channels[0]) return true;
        const frames = channels[0].length;
        const pcm = new Int16Array(frames);
        const count = channels.length;
        for (let i = 0; i < frames; i++) {
            let sum = 0;
            for (let c = 0; c < count; c++) sum += channels[c][i] || 0;
            let s = sum / count;
            if (s < -1) s = -1;
            else if (s > 1) s = 1;
            pcm[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        return true;
    }
}
registerProcessor('ws-mic-capture', WsMicCapture);
`;

export function describeMicCaptureError(err: unknown): string {
    const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        return '浏览器没有弹出或已经拒绝麦克风。若之前点过拒绝，请到这个网站的站点设置里改为允许。这里不会自动再请求。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return '没有找到麦克风。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
        return '系统或其他程序正占用麦克风，这次没有打开。';
    }
    if (name === 'SecurityError') {
        return '浏览器禁止这个页面使用麦克风。公网明文 HTTP 不行；嵌在窗口里时还需要允许麦克风。';
    }
    if (name === 'OverconstrainedError') {
        return '这只麦克风不支持当前采集格式。';
    }
    return '无法打开麦克风。';
}

export async function captureMicrophone(onFrame: (pcm: Int16Array, sampleRate: number) => void): Promise<() => void> {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
        throw new Error('浏览器不支持麦克风采集（需要 localhost 或 HTTPS）');
    }
    const stream = await media.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
        video: false,
    });
    const Ctx =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
        stopStream(stream);
        throw new Error('浏览器不支持音频处理');
    }
    const ctx = new Ctx();
    await ctx.resume().catch(() => undefined);
    const source = ctx.createMediaStreamSource(stream);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    silent.connect(ctx.destination);
    let usedWorklet = false;
    try {
        usedWorklet = await attachWorklet(ctx, source, silent, onFrame);
    } catch {
        usedWorklet = false;
    }
    if (!usedWorklet) attachScriptProcessor(ctx, source, silent, onFrame);
    let stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        try {
            source.disconnect();
            silent.disconnect();
        } catch {
            // already disconnected
        }
        stopStream(stream);
        void ctx.close().catch(() => undefined);
    };
}

async function attachWorklet(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    silent: GainNode,
    onFrame: (pcm: Int16Array, sampleRate: number) => void,
): Promise<boolean> {
    if (!ctx.audioWorklet) return false;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
        await ctx.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(ctx, 'ws-mic-capture');
        node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
            onFrame(new Int16Array(event.data), ctx.sampleRate);
        };
        source.connect(node);
        node.connect(silent);
        return true;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function attachScriptProcessor(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    silent: GainNode,
    onFrame: (pcm: Int16Array, sampleRate: number) => void,
): void {
    const processor = ctx.createScriptProcessor(1024, 1, 1);
    processor.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const channels: Float32Array[] = [];
        for (let i = 0; i < input.numberOfChannels; i++) channels.push(input.getChannelData(i));
        const mono = downmixToMono(channels, input.length);
        onFrame(floatToS16le(mono), ctx.sampleRate);
    };
    source.connect(processor);
    processor.connect(silent);
}

function stopStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) track.stop();
}
