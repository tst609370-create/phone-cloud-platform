/**
 * VideoDecoder-shaped H.264 decoder built on Media Source Extensions.
 *
 * WebCodecs (`VideoDecoder`, `EncodedVideoChunk`) only exists in secure
 * contexts. The console is reached over http://<public IP>:port through the
 * frp relay, so remote viewers had no decoder at all. MSE works on plain HTTP:
 * each access unit is muxed into a one-sample fMP4 fragment, played by a
 * hidden muted <video>, and handed to the canvas player as the "frame".
 */
import { extractParams, FMP4_TIMESCALE, initSegment, mediaSegment, mimeCodec, toAvccSample } from './fmp4';

export interface ChunkLike {
    type: 'key' | 'delta';
    timestamp: number;
    data: Uint8Array;
}

export interface MseDecoderInit {
    output: (frame: VideoFrame) => void;
    error: (error: DOMException) => void;
}

type FrameVideo = HTMLVideoElement & {
    displayWidth: number;
    displayHeight: number;
    codedWidth: number;
    codedHeight: number;
    close: () => void;
};

/** Nominal 30 fps sample duration; the live-edge seek below absorbs drift. */
const SAMPLE_DURATION = Math.round(FMP4_TIMESCALE / 30);
const MAX_LATENCY_S = 0.25;

export function mseSupported(): boolean {
    try {
        const MS = (globalThis as { MediaSource?: typeof MediaSource }).MediaSource;
        return typeof MS === 'function' && MS.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
    } catch {
        return false;
    }
}

export class MseVideoDecoder {
    public state: CodecState = 'unconfigured';
    public decodeQueueSize = 0;
    public readonly video: FrameVideo;
    private mediaSource?: MediaSource | undefined;
    private sourceBuffer?: SourceBuffer | undefined;
    private pending: Uint8Array[] = [];
    private configData?: Uint8Array | undefined;
    private paramsKey = '';
    private sequence = 1;
    private decodeTime = 0;
    private rafId?: number | undefined;
    private lastTime = -1;
    private appended = false;

    constructor(private readonly init: MseDecoderInit) {
        const video = document.createElement('video') as FrameVideo;
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.setAttribute('aria-hidden', 'true');
        video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
        Object.defineProperty(video, 'displayWidth', { get: () => video.videoWidth });
        Object.defineProperty(video, 'displayHeight', { get: () => video.videoHeight });
        Object.defineProperty(video, 'codedWidth', { get: () => video.videoWidth });
        Object.defineProperty(video, 'codedHeight', { get: () => video.videoHeight });
        video.close = () => undefined;
        this.video = video;
    }

    /** SPS/PPS for the next configure(); WebCodecs gets them in-band instead. */
    public setConfigData(data: Uint8Array): void {
        this.configData = data;
    }

    public configure(config: VideoDecoderConfig): void {
        if (this.state === 'closed') throw new DOMException('decoder closed', 'InvalidStateError');
        const params = this.configData
            ? extractParams(this.configData, config.codedWidth ?? 0, config.codedHeight ?? 0)
            : null;
        if (!params) {
            this.fail('MSE 回退只支持 H.264');
            return;
        }
        const key = `${mimeCodec(params)}|${params.width}x${params.height}|${Array.from(params.sps).join(',')}|${Array.from(params.pps).join(',')}`;
        if (key !== this.paramsKey) {
            this.paramsKey = key;
            this.open(`video/mp4; codecs="${mimeCodec(params)}"`, initSegment(params));
        }
        this.state = 'configured';
    }

    public decode(chunk: ChunkLike): void {
        if (this.state !== 'configured') throw new DOMException('decoder not configured', 'InvalidStateError');
        const sample = toAvccSample(chunk.data);
        if (!sample.length) return;
        this.enqueue(mediaSegment(this.sequence++, this.decodeTime, SAMPLE_DURATION, sample, chunk.type === 'key'));
        this.decodeTime += SAMPLE_DURATION;
    }

    public reset(): void {
        if (this.state !== 'closed') this.state = 'unconfigured';
    }

    public close(): void {
        this.state = 'closed';
        this.teardown();
    }

    public flush(): Promise<void> {
        return Promise.resolve();
    }

    private fail(message: string): void {
        this.state = 'closed';
        this.teardown();
        this.init.error(new DOMException(message, 'NotSupportedError'));
    }

    private open(mime: string, init: Uint8Array): void {
        this.teardown();
        if (!MediaSource.isTypeSupported(mime)) {
            this.fail(`浏览器不支持 ${mime}`);
            return;
        }
        this.sequence = 1;
        this.decodeTime = 0;
        this.pending = [init];
        const mediaSource = new MediaSource();
        this.mediaSource = mediaSource;
        mediaSource.addEventListener(
            'sourceopen',
            () => {
                if (this.mediaSource !== mediaSource) return;
                try {
                    const sb = mediaSource.addSourceBuffer(mime);
                    sb.mode = 'segments';
                    sb.addEventListener('updateend', () => this.onUpdateEnd(sb));
                    sb.addEventListener('error', () => this.fail('MSE 追加失败'));
                    this.sourceBuffer = sb;
                    this.pump();
                } catch (e) {
                    this.fail(`MSE 初始化失败：${(e as Error).message}`);
                }
            },
            { once: true },
        );
        if (!this.video.isConnected && document.body) document.body.appendChild(this.video);
        this.video.src = URL.createObjectURL(mediaSource);
        this.startLoop();
    }

    private enqueue(segment: Uint8Array): void {
        this.pending.push(segment);
        // A stalled SourceBuffer must not grow without bound.
        if (this.pending.length > 120) this.pending.splice(1, this.pending.length - 60);
        this.pump();
    }

    private pump(): void {
        const sb = this.sourceBuffer;
        if (!sb || sb.updating || !this.pending.length || this.mediaSource?.readyState !== 'open') return;
        const next = this.pending.shift()!;
        try {
            sb.appendBuffer(next as BufferSource);
        } catch (e) {
            if ((e as DOMException).name === 'QuotaExceededError') {
                this.pending.unshift(next);
                this.prune(sb, true);
                return;
            }
            this.fail(`MSE 追加失败：${(e as Error).message}`);
        }
    }

    private onUpdateEnd(sb: SourceBuffer): void {
        this.appended = true;
        const v = this.video;
        if (sb.buffered.length) {
            const end = sb.buffered.end(sb.buffered.length - 1);
            const start = sb.buffered.start(sb.buffered.length - 1);
            // Stay at the live edge: never let the picture drift behind the phone.
            if (end - v.currentTime > MAX_LATENCY_S || v.currentTime < start) {
                v.currentTime = Math.max(start, end - 0.02);
            }
        }
        if (v.paused) v.play().catch(() => undefined);
        if (!this.prune(sb, false)) this.pump();
    }

    /** Drop old media so the buffer stays small. Returns true when a removal started. */
    private prune(sb: SourceBuffer, force: boolean): boolean {
        if (sb.updating || !sb.buffered.length) return false;
        const start = sb.buffered.start(0);
        const keepFrom = this.video.currentTime - 3;
        if (keepFrom - start > (force ? 0.5 : 10)) {
            try {
                sb.remove(start, keepFrom);
                return true;
            } catch {
                return false;
            }
        }
        return false;
    }

    private startLoop(): void {
        if (this.rafId !== undefined) return;
        const tick = () => {
            this.rafId = undefined;
            if (this.state === 'closed') return;
            const v = this.video;
            if (v.readyState >= 2 && v.videoWidth && (v.currentTime !== this.lastTime || this.appended)) {
                this.lastTime = v.currentTime;
                this.appended = false;
                this.init.output(v as unknown as VideoFrame);
            }
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    private teardown(): void {
        if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
        this.rafId = undefined;
        const ms = this.mediaSource;
        this.mediaSource = undefined;
        this.sourceBuffer = undefined;
        this.pending = [];
        this.paramsKey = this.state === 'closed' ? '' : this.paramsKey;
        if (ms) {
            try {
                if (ms.readyState === 'open') ms.endOfStream();
            } catch {
                /* already ended */
            }
            const src = this.video.src;
            this.video.removeAttribute('src');
            this.video.load();
            if (src.startsWith('blob:')) URL.revokeObjectURL(src);
        }
        if (this.state === 'closed') this.video.remove();
    }
}
