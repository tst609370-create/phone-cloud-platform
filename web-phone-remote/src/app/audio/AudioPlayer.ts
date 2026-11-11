// src/app/audio/AudioPlayer.ts
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './PcmWorklet';
import { decodeS16LEToFloat32Planar } from './pcmConvert';
import {
    audioProblem,
    browserAudioBlock,
    newAudioHealth,
    noteFrame,
    peakOf,
    type AudioHealthState,
} from './audioHealth';

/** Called with a plain-language reason while the user can't hear anything, undefined once audio plays. */
export type AudioStatusListener = (problem: string | undefined) => void;

export class AudioPlayer {
    private audioContext?: AudioContext;
    private decoder?: AudioDecoder;
    private workletNode?: AudioWorkletNode | undefined;
    private gainNode?: GainNode;
    private started = false;
    private workletReady = false;
    /** http:// pages have no AudioWorklet; schedule AudioBuffers instead. */
    private bufferMode = false;
    private nextPlayTime = 0;
    private configData?: Uint8Array | undefined;
    private health: AudioHealthState = newAudioHealth(Date.now());
    private healthTimer?: ReturnType<typeof setInterval> | undefined;
    private lastProblem: string | undefined = '';

    constructor(
        private readonly codec: string,
        private readonly onStatus?: AudioStatusListener,
    ) {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        this.health = newAudioHealth(Date.now());
        this.healthTimer = setInterval(() => this.report(), 1000);

        const block = browserAudioBlock(this.codec, {
            hasAudioContext: typeof AudioContext !== 'undefined',
            hasAudioDecoder: typeof AudioDecoder !== 'undefined',
            secure: typeof isSecureContext === 'boolean' ? isSecureContext : true,
        });
        if (block) {
            this.fail(block);
            return;
        }

        try {
            this.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
        } catch {
            this.audioContext = new AudioContext();
        }
        this.audioContext.onstatechange = () => this.report();
        this.gainNode = this.audioContext.createGain();
        this.gainNode.connect(this.audioContext.destination);

        if (this.audioContext.audioWorklet) {
            try {
                const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
                const url = URL.createObjectURL(blob);
                await this.audioContext.audioWorklet.addModule(url);
                URL.revokeObjectURL(url);
                this.workletNode = new AudioWorkletNode(this.audioContext, PCM_WORKLET_NAME, {
                    outputChannelCount: [2],
                });
                this.workletNode.connect(this.gainNode);
            } catch {
                this.workletNode = undefined;
            }
        }
        this.bufferMode = !this.workletNode;
        this.workletReady = true;
        // Try right away: allowed when the page (or its same-origin parent) was clicked.
        this.audioContext.resume().catch(() => undefined);
        this.report();

        if (this.codec === 'raw') return;
        if (typeof AudioDecoder.isConfigSupported === 'function') {
            try {
                const support = await AudioDecoder.isConfigSupported({
                    codec: this.webCodecsCodecString(),
                    sampleRate: 48000,
                    numberOfChannels: 2,
                });
                if (!support.supported) {
                    this.fail(`浏览器不支持 ${this.codec} 声音解码，请升级 Chrome/Edge`);
                    return;
                }
            } catch {
                /* AAC/FLAC need a description first; let configure() decide */
            }
        }
        this.createDecoder();
    }

    private fail(reason: string): void {
        this.health.fatal = reason;
        this.report();
    }

    private report(): void {
        if (!this.started) return;
        this.health.suspended = this.audioContext?.state === 'suspended';
        const problem = audioProblem(this.health, Date.now());
        if (problem === this.lastProblem) return;
        this.lastProblem = problem;
        if (problem) console.warn('[AudioPlayer]', problem);
        this.onStatus?.(problem);
    }

    /** A decoder error closes the WebCodecs decoder for good, so build a fresh one. */
    private createDecoder(): void {
        this.decoder = new AudioDecoder({
            output: (audioData: AudioData) => {
                this.postDecodedAudio(audioData);
            },
            error: (err: DOMException) => {
                console.error('[AudioPlayer] Decoder error:', err.message);
                if (!this.started) return;
                try {
                    this.createDecoder();
                } catch {
                    this.fail(`声音解码失败：${err.message}`);
                }
            },
        });
        this.configureDecoder();
    }

    private configureDecoder(): void {
        if (!this.decoder) return;

        const config: AudioDecoderConfig = {
            codec: this.webCodecsCodecString(),
            sampleRate: 48000,
            numberOfChannels: 2,
        };

        // AAC and FLAC need the config packet as description
        if ((this.codec === 'aac' || this.codec === 'flac') && this.configData) {
            config.description = this.configData;
        }

        // Opus is self-contained; configure immediately
        // AAC/FLAC configure after receiving config packet (configureDecoder called from pushFrame)
        if (this.codec === 'opus' || this.configData) {
            try {
                this.decoder.configure(config);
            } catch (err) {
                this.fail(`声音解码器配置失败：${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    private webCodecsCodecString(): string {
        switch (this.codec) {
            case 'opus':
                return 'opus';
            case 'aac':
                return 'mp4a.40.2';
            case 'flac':
                return 'flac';
            default:
                return this.codec;
        }
    }

    private postDecodedAudio(audioData: AudioData): void {
        if (!this.workletReady) {
            audioData.close();
            return;
        }
        const numChannels = audioData.numberOfChannels;
        const numFrames = audioData.numberOfFrames;
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < numChannels; ch++) {
            const channelData = new Float32Array(numFrames);
            audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
            channels.push(channelData);
        }
        audioData.close();
        this.play(channels, numFrames);
    }

    private play(channels: Float32Array[], numFrames: number): void {
        noteFrame(this.health, Date.now(), peakOf(channels));
        if (this.bufferMode) {
            this.schedule(channels, numFrames);
            return;
        }
        this.workletNode!.port.postMessage(
            { channels, numFrames },
            channels.map((c) => c.buffer),
        );
    }

    /** Worklet-free playback: queue each chunk right after the previous one. */
    private schedule(channels: Float32Array[], numFrames: number): void {
        const ctx = this.audioContext;
        if (!ctx || !this.gainNode || numFrames <= 0 || ctx.state !== 'running') return;
        const buffer = ctx.createBuffer(2, numFrames, 48000);
        for (let ch = 0; ch < 2; ch++) {
            buffer.getChannelData(ch).set(channels[Math.min(ch, channels.length - 1)]!);
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode);
        const now = ctx.currentTime;
        // Underrun or drift past 250 ms: restart 60 ms ahead, as the worklet does.
        if (this.nextPlayTime < now || this.nextPlayTime > now + 0.25) this.nextPlayTime = now + 0.06;
        source.start(this.nextPlayTime);
        this.nextPlayTime += buffer.duration;
    }

    pushFrame(data: Uint8Array, pts: bigint, isConfig: boolean): void {
        if (this.health.firstFrameAt === undefined && !isConfig) noteFrame(this.health, Date.now(), undefined);
        if (this.codec === 'raw') {
            this.pushRawPcm(data);
            return;
        }

        if (isConfig) {
            this.configData = new Uint8Array(data);
            // For AAC/FLAC, (re)configure decoder now that we have the config
            if (this.codec === 'aac' || this.codec === 'flac') {
                this.configureDecoder();
            }
            return;
        }

        if (this.decoder?.state !== 'configured') return;

        this.decoder.decode(
            new EncodedAudioChunk({
                type: 'key',
                timestamp: Number(pts),
                data,
            }),
        );
    }

    /** Raw PCM: convert S16LE samples to Float32 and play directly. */
    private pushRawPcm(data: Uint8Array): void {
        if (!this.workletReady) return;
        const channels = decodeS16LEToFloat32Planar(data, 2);
        this.play(channels, channels[0]?.length ?? 0);
    }

    async resume(): Promise<void> {
        if (this.audioContext?.state === 'suspended') {
            await this.audioContext.resume().catch(() => undefined);
        }
        this.report();
    }

    setVolume(volume: number): void {
        if (this.gainNode) {
            this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
        }
    }

    stop(): void {
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = undefined;
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.workletNode?.disconnect();
        this.gainNode?.disconnect();
        this.audioContext?.close().catch(() => undefined);
        this.started = false;
        this.workletReady = false;
        this.configData = undefined;
        this.bufferMode = false;
    }
}
