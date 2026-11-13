import type { DisplayInfo } from '../DisplayInfo';
import Rect from '../Rect';
import ScreenInfo from '../ScreenInfo';
import Size from '../Size';
import VideoSettings from '../VideoSettings';
import { OBU_TYPE, obuType, parseAv1ConfigRecord, parseAv1SequenceHeader } from './av1-utils';
import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import { BasePlayer } from './BasePlayer';
import { parseSPS, stripEmulationPrevention } from './h264-utils';
import { HEVC_NAL_TYPE, hevcNalType, parseHevcSPS } from './h265-utils';
import { MseVideoDecoder, mseSupported } from './mseDecoder';
import { findFirstNaluOffset, findNaluByHeader } from './naluScanner';
import { buildDecoderConfig } from './webCodecsConfig';

function toHex(value: number) {
    return value.toString(16).padStart(2, '0').toUpperCase();
}

export class WebCodecsPlayer extends BaseCanvasBasedPlayer {
    public static override readonly storageKeyPrefix = 'WebCodecsPlayer';
    public static override readonly playerFullName = 'connect';
    public static override readonly playerCodeName = 'webcodecs';

    public static override readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 8000000,
        maxFps: 15,
        iFrameInterval: 2,
        bounds: new Size(0, 0),
        sendFrameMeta: false,
    });

    public static override isSupported(): boolean {
        return WebCodecsPlayer.hasWebCodecs() || mseSupported();
    }

    /** WebCodecs exists only in secure contexts (https / localhost); http://<public IP> falls back to MSE. */
    public static hasWebCodecs(): boolean {
        return typeof VideoDecoder === 'function' && typeof VideoDecoder.isConfigSupported === 'function';
    }

    private static chunk(init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }): EncodedVideoChunk {
        return WebCodecsPlayer.hasWebCodecs() ? new EncodedVideoChunk(init) : (init as unknown as EncodedVideoChunk);
    }

    private static parseSPSCodecString(data: Uint8Array): { codec: string; width: number; height: number } {
        // Strip RBSP emulation-prevention bytes before bitstream parsing, mirroring
        // the H.265 path (parseHevcSPS strips internally). An SPS containing a
        // 00 00 03 triple would otherwise be mis-parsed (finding #42).
        const {
            profile_idc,
            constraint_set_flags,
            level_idc,
            pic_width_in_mbs_minus1,
            frame_crop_left_offset,
            frame_crop_right_offset,
            frame_mbs_only_flag,
            pic_height_in_map_units_minus1,
            frame_crop_top_offset,
            frame_crop_bottom_offset,
            sar,
        } = parseSPS(stripEmulationPrevention(data));

        const sarScale = sar[0] / sar[1];
        const codec = `avc1.${[profile_idc, constraint_set_flags, level_idc].map(toHex).join('')}`;
        const width = Math.ceil(
            ((pic_width_in_mbs_minus1 + 1) * 16 - frame_crop_left_offset * 2 - frame_crop_right_offset * 2) * sarScale,
        );
        const height =
            (2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1) * 16 -
            (frame_mbs_only_flag ? 2 : 4) * (frame_crop_top_offset + frame_crop_bottom_offset);
        return { codec, width, height };
    }

    public override readonly supportsScreenshot = true;
    private context: CanvasRenderingContext2D;
    private decoder: VideoDecoder;
    private decoderConfig?: VideoDecoderConfig;
    private droppingUntilKeyframe = false;
    private configData?: Uint8Array | undefined;
    private detectedCodec: 'h264' | 'h265' | 'av1' | null = null;
    private metadataWidth = 0;
    private metadataHeight = 0;
    private loggedFrameSize = false;
    /** True until a keyframe has been fed since the last configure()/reset(). */
    private needKeyframe = true;
    private decodeErrors = 0;
    private outputWatchdog?: ReturnType<typeof setTimeout> | undefined;
    private gotOutput = false;
    private stallTimer?: ReturnType<typeof setTimeout> | undefined;
    private stallCount = 0;
    /** Set by StreamClientScrcpy: sends scrcpy RESET_VIDEO so the phone re-sends config + keyframe. */
    public onNeedKeyframe?: (() => void) | undefined;
    private lastBlackCheck = 0;
    private blackSince = 0;
    private healthReported = '';
    private blackProbe?: HTMLCanvasElement;
    private static readonly SOFTWARE_KEY = 'webcodecs-prefer-software';
    private static readonly OUTPUT_TIMEOUT_MS = 3000;

    /** Hardware decoders on some Windows GPUs/drivers accept frames but never output (black screen). */
    private static preferSoftware(): boolean {
        try {
            return globalThis.localStorage?.getItem(WebCodecsPlayer.SOFTWARE_KEY) === '1';
        } catch {
            return false;
        }
    }

    private static rememberSoftware(): void {
        try {
            globalThis.localStorage?.setItem(WebCodecsPlayer.SOFTWARE_KEY, '1');
        } catch {
            /* storage unavailable: retry in software for this session only */
        }
    }

    constructor(udid: string, displayInfo?: DisplayInfo, name = WebCodecsPlayer.playerFullName) {
        super(udid, displayInfo, name, WebCodecsPlayer.storageKeyPrefix);
        const context = this.tag.getContext('2d');
        if (!context) {
            throw Error('Failed to get 2d context from canvas');
        }
        this.context = context;
        this.decoder = this.createDecoder();
    }

    private createDecoder(): VideoDecoder {
        const DecoderClass = (WebCodecsPlayer.hasWebCodecs() ? VideoDecoder : MseVideoDecoder) as typeof VideoDecoder;
        return new DecoderClass({
            output: (frame) => {
                if (!this.loggedFrameSize) {
                    console.log(
                        `[WebCodecsPlayer] First decoded frame: display=${frame.displayWidth}x${frame.displayHeight} coded=${frame.codedWidth}x${frame.codedHeight} canvas=${this.tag.width}x${this.tag.height}`,
                    );
                    this.loggedFrameSize = true;
                }
                this.gotOutput = true;
                this.decodeErrors = 0;
                this.stallCount = 0;
                this.clearOutputWatchdog();
                this.clearStallTimer();
                this.onFrameDecoded(frame.displayWidth, frame.displayHeight, frame);
            },
            error: (error: DOMException) => {
                console.error('[WebCodecsPlayer]', error, `code: ${error.code}`);
                this.recoverDecoder(`解码出错：${error.message || error.name}`);
            },
        });
    }

    private withAcceleration(config: VideoDecoderConfig): VideoDecoderConfig {
        return WebCodecsPlayer.preferSoftware() ? { ...config, hardwareAcceleration: 'prefer-software' } : config;
    }

    private configureDecoder(): void {
        if (!this.decoderConfig) return;
        if (this.decoder.state === 'closed') this.decoder = this.createDecoder();
        else if (this.decoder.state === 'configured') this.decoder.reset();
        if (this.configData && this.decoder instanceof MseVideoDecoder) this.decoder.setConfigData(this.configData);
        this.decoder.configure(this.withAcceleration(this.decoderConfig));
        this.needKeyframe = true;
    }

    /** Tell the embedding page (phones.js) the picture is missing so 「自动」 can step down. */
    private reportHealth(state: 'black' | 'none' | 'ok'): void {
        if (this.healthReported === 'ok' && state === 'black') return;
        if (this.healthReported === state) return;
        this.healthReported = state;
        try {
            const win = this.tag.ownerDocument?.defaultView;
            win?.dispatchEvent(new win.CustomEvent('phone-video-health', { detail: { state } }));
        } catch {
            /* cosmetic */
        }
    }

    /**
     * Some phone encoders (OnePlus/ColorOS at larger sizes) emit frames that
     * decode to solid black. Android always draws a status bar, so a frame with
     * no pixel brighter than ~16 for 4 s means the stream is broken.
     */
    private checkBlack(frame: CanvasImageSource): void {
        const now = Date.now();
        if (now - this.lastBlackCheck < 1000) return;
        this.lastBlackCheck = now;
        try {
            // Probe the decoded frame itself, not the canvas: notice text drawn on
            // the canvas ("等待手机画面…") used to count as a real picture.
            const probe = (this.blackProbe ??= this.tag.ownerDocument.createElement('canvas'));
            probe.width = 96;
            probe.height = 192;
            const ctx = probe.getContext('2d', { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(frame, 0, 0, 96, 192);
            const data = ctx.getImageData(0, 0, 96, 192).data;
            let max = 0;
            for (let i = 0; i < data.length && max <= 16; i += 4)
                max = Math.max(max, data[i]!, data[i + 1]!, data[i + 2]!);
            if (max > 16) {
                // Real picture seen: stop probing (only the start of a stream matters).
                this.reportHealth('ok');
                return;
            }
            if (!this.blackSince) this.blackSince = now;
            else if (now - this.blackSince >= 4000) this.reportHealth('black');
        } catch {
            /* unavailable: skip */
        }
    }

    private clearStallTimer(): void {
        if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
        this.stallTimer = undefined;
    }

    /**
     * Config arrived but no picture yet: a keyframe may have been lost on a slow
     * relay, or the phone's screen is off / on a secure lock screen. Ask the
     * phone for a new keyframe and say so on the canvas instead of plain black.
     */
    private armStallTimer(): void {
        if (this.gotOutput || this.stallTimer !== undefined || this.stallCount >= 5) return;
        this.stallTimer = setTimeout(() => {
            this.stallTimer = undefined;
            if (this.gotOutput) return;
            this.stallCount++;
            try {
                this.onNeedKeyframe?.();
            } catch {
                /* control channel not ready yet */
            }
            this.drawNotice(
                this.stallCount >= 2 ? '手机没有出画面：可能息屏或停在锁屏，点「全部亮屏」' : '等待手机画面…',
            );
            if (this.stallCount >= 2) this.reportHealth('none');
            this.armStallTimer();
        }, 2500);
    }

    private clearOutputWatchdog(): void {
        if (this.outputWatchdog !== undefined) clearTimeout(this.outputWatchdog);
        this.outputWatchdog = undefined;
    }

    /**
     * A decoder error used to stop the player for good: the canvas kept its size
     * and the status bar looked connected, but the picture stayed black. Rebuild
     * the decoder and resume on the next keyframe; after a failure, fall back to
     * software decoding (remembered in this browser).
     */
    private recoverDecoder(reason: string): void {
        this.clearOutputWatchdog();
        this.decodeErrors++;
        if (!WebCodecsPlayer.preferSoftware()) {
            WebCodecsPlayer.rememberSoftware();
            console.warn('[WebCodecsPlayer] switching to software decoding:', reason);
        }
        this.drawNotice(this.decodeErrors > 3 ? `${reason}，请刷新或换浏览器` : '画面恢复中…');
        try {
            if (this.decoder.state !== 'closed') this.decoder.close();
        } catch {
            /* already closed */
        }
        this.decoder = this.createDecoder();
        this.droppingUntilKeyframe = false;
        if (this.decodeErrors <= 5) this.configureDecoder();
    }

    private drawNotice(text: string): void {
        if (this.gotOutput) return; // keep the last good picture instead
        try {
            const { width, height } = this.tag;
            if (!width || !height) return;
            this.context.save();
            this.context.fillStyle = '#000';
            this.context.fillRect(0, 0, width, height);
            this.context.fillStyle = '#ccc';
            this.context.font = `${Math.max(14, Math.round(width / 22))}px sans-serif`;
            this.context.textAlign = 'center';
            this.context.fillText(text, width / 2, height / 2);
            this.context.restore();
        } catch {
            /* cosmetic */
        }
    }

    /**
     * Called by ScrcpyDemuxer via StreamClientScrcpy with pre-parsed frame metadata.
     * Replaces the old pushFrame(Uint8Array) → decode() pipeline.
     */
    public pushVideoFrame(data: Uint8Array, pts: bigint, isConfig: boolean, isKeyframe: boolean): void {
        // Track stats via BasePlayer. Pass the demuxer's real keyframe flag so the
        // shared signature carries it (works for H.264/H.265/AV1) — see finding #43.
        BasePlayer.prototype.pushFrame.call(this, data, isKeyframe);

        if (isConfig) {
            let result: { codec: string; width?: number; height?: number } | null = null;
            try {
                result = this.parseConfig(data);
            } catch (e) {
                console.error('[WebCodecsPlayer] parseConfig error:', e);
            }
            if (result) {
                // Coded dimensions from codec SPS (may include alignment padding, e.g. 1088 for 1080)
                const codedW = result.width || this.metadataWidth;
                const codedH = result.height || this.metadataHeight;
                // Display dimensions from scrcpy metadata (actual device screen size).
                // scrcpy-server rejects touch events whose screenSize doesn't match its video size,
                // so we must use display dimensions for canvas/touch sizing, not coded dimensions.
                const displayW = this.metadataWidth || result.width;
                const displayH = this.metadataHeight || result.height;
                if (displayW && displayH && displayW > 0 && displayH > 0) {
                    this.scaleCanvas(displayW, displayH);
                }
                // Keep Annex B parameter sets out of `description`: browsers parse
                // that field as avcC/hvcC, not Annex B.
                this.decoderConfig = buildDecoderConfig({
                    codec: result.codec,
                    detectedCodec: this.detectedCodec,
                    codedWidth: codedW,
                    codedHeight: codedH,
                    configData: data,
                });
                this.configData = new Uint8Array(data);
                this.configureDecoder();
                this.droppingUntilKeyframe = false;
                this.armStallTimer();
            }
            this.configData = new Uint8Array(data);
            return;
        }

        if (this.decoder.state !== 'configured') return;

        // WebCodecs queues compressed frames internally. On a slow/remote client,
        // decoding every queued delta frame makes clicks look seconds late. Once
        // the queue grows, discard deltas and restart at the next keyframe so the
        // canvas always catches up to the phone's current screen.
        if (this.decoder.decodeQueueSize > 4 && !this.droppingUntilKeyframe) {
            this.droppingUntilKeyframe = true;
            // scrcpy only sends a keyframe every ~10 s by itself: ask for one
            // now, otherwise the picture freezes until then.
            try {
                this.onNeedKeyframe?.();
            } catch {
                /* control channel not ready */
            }
        }
        if (this.droppingUntilKeyframe) {
            if (!isKeyframe || !this.decoderConfig) return;
            this.configureDecoder();
            this.droppingUntilKeyframe = false;
        }

        if (isKeyframe && this.configData) {
            if (!this.receivedFirstFrame) {
                this.receivedFirstFrame = true;
            }

            let chunkData = data;
            if (this.detectedCodec === 'h264' || this.detectedCodec === 'h265') {
                chunkData = new Uint8Array(this.configData.length + data.length);
                chunkData.set(this.configData);
                chunkData.set(data, this.configData.length);
            }
            this.decoder.decode(
                WebCodecsPlayer.chunk({
                    type: 'key',
                    timestamp: Number(pts),
                    data: chunkData,
                }),
            );
            this.needKeyframe = false;
            this.armOutputWatchdog();
            return;
        }

        // A delta right after configure()/reset() makes the decoder throw
        // ("key frame is required"). BasePlayer.pushFrame already flipped
        // receivedFirstFrame on the config packet, so track keyframes here.
        if (!this.receivedFirstFrame || this.needKeyframe) return;

        this.decoder.decode(
            WebCodecsPlayer.chunk({
                type: isKeyframe ? 'key' : 'delta',
                timestamp: Number(pts),
                data,
            }),
        );
    }

    /** Find offset of NALU with given type in Annex B stream. Returns -1 if not found. */
    private findNaluOffset(data: Uint8Array, naluType: number): number {
        return findNaluByHeader(data, (b) => (b & 0x1f) === naluType);
    }

    private parseConfig(data: Uint8Array): { codec: string; width?: number; height?: number } | null {
        // Try Annex B start code detection (H.264/H.265)
        const naluOffset = this.findStartCode(data);
        if (naluOffset >= 0) {
            const firstByte = data[naluOffset]!;
            const h265Type = hevcNalType(firstByte);

            if (h265Type === HEVC_NAL_TYPE.VPS || h265Type === HEVC_NAL_TYPE.SPS) {
                this.detectedCodec = 'h265';
                const spsOffset = this.findHevcNalu(data, HEVC_NAL_TYPE.SPS);
                if (spsOffset >= 0) {
                    return parseHevcSPS(data.subarray(spsOffset));
                }
            } else {
                const h264Type = firstByte & 0x1f;
                if (h264Type === 7) {
                    this.detectedCodec = 'h264';
                    const spsOffset = this.findNaluOffset(data, 7);
                    if (spsOffset >= 0) {
                        return WebCodecsPlayer.parseSPSCodecString(data.subarray(spsOffset));
                    }
                }
            }
            return null;
        }

        // No Annex B start code — try AV1
        if (data.length >= 4) {
            // Try AV1CodecConfigurationRecord first (4 bytes, marker=1)
            const configRecord = parseAv1ConfigRecord(data);
            if (configRecord) {
                this.detectedCodec = 'av1';
                return { ...configRecord, width: 0, height: 0 };
            }
            // Try raw OBU Sequence Header
            if (obuType(data[0]!) === OBU_TYPE.SEQUENCE_HEADER) {
                this.detectedCodec = 'av1';
                return parseAv1SequenceHeader(data);
            }
        }

        return null;
    }

    private findStartCode(data: Uint8Array): number {
        return findFirstNaluOffset(data);
    }

    private findHevcNalu(data: Uint8Array, nalType: number): number {
        return findNaluByHeader(data, (b) => hevcNalType(b) === nalType);
    }

    /** Set fallback dimensions from stream metadata (used by AV1 which doesn't include dimensions in config). */
    public setMetadataSize(width: number, height: number): void {
        this.metadataWidth = width;
        this.metadataHeight = height;
    }

    protected scaleCanvas(width: number, height: number): void {
        const videoSize = new Size(width, height);
        let scale = 1;
        if (this.bounds && !this.bounds.intersect(videoSize).equals(videoSize)) {
            scale = Math.min(this.bounds.w / width, this.bounds.h / height);
        }
        const w = width * scale;
        const h = height * scale;
        const screenInfo = new ScreenInfo(new Rect(0, 0, width, height), new Size(w, h), 0);
        this.emit('input-video-resize', screenInfo);
        this.setScreenInfo(screenInfo);
        this.initCanvas(width, height);
        if (scale !== 1) {
            this.tag.style.transform = `scale(${scale.toFixed(4)})`;
        } else {
            this.tag.style.transform = '';
        }
        this.tag.style.transformOrigin = 'top left';
    }

    /** Legacy decode path — not used with v3.x demuxer. */
    protected override decode(_data: Uint8Array): void {
        // No-op: v3.x uses pushVideoFrame() instead
    }

    protected override drawDecoded = (): void => {
        if (this.receivedFirstFrame) {
            while (this.decodedFrames.length > 1) {
                const stale = this.decodedFrames.shift();
                if (stale) this.dropFrame(stale.frame);
            }
            const data = this.decodedFrames.shift();
            if (data) {
                const frame: VideoFrame = data.frame;
                const cw = this.tag.width;
                const ch = this.tag.height;
                // Edge H.265: displayWidth differs from codedWidth. Use full coded
                // rect as source to draw the complete frame, not just the visible rect.
                if (frame.displayWidth !== frame.codedWidth || frame.displayHeight !== frame.codedHeight) {
                    this.context.drawImage(frame, 0, 0, frame.codedWidth, frame.codedHeight, 0, 0, cw, ch);
                } else {
                    this.context.drawImage(frame, 0, 0);
                }
                if (!this.healthReported) this.checkBlack(frame as unknown as CanvasImageSource);
                frame.close?.();
            }
        }
        if (this.decodedFrames.length) {
            this.animationFrameId = requestAnimationFrame(this.drawDecoded);
        } else {
            this.animationFrameId = undefined;
        }
    };

    protected override dropFrame(frame: VideoFrame): void {
        frame.close?.();
    }

    public override getFitToScreenStatus(): boolean {
        return false;
    }

    public override getPreferredVideoSetting(): VideoSettings {
        return WebCodecsPlayer.preferredVideoSettings;
    }

    public override loadVideoSettings(): VideoSettings {
        return WebCodecsPlayer.loadVideoSettings(this.udid, this.displayInfo);
    }

    protected override needScreenInfoBeforePlay(): boolean {
        return false;
    }

    /** No picture within a few seconds of a keyframe → hardware decoder is stuck; retry in software. */
    private armOutputWatchdog(): void {
        if (
            this.gotOutput ||
            this.outputWatchdog !== undefined ||
            !WebCodecsPlayer.hasWebCodecs() ||
            WebCodecsPlayer.preferSoftware()
        )
            return;
        this.outputWatchdog = setTimeout(() => {
            this.outputWatchdog = undefined;
            if (!this.gotOutput) this.recoverDecoder('硬件解码无画面');
        }, WebCodecsPlayer.OUTPUT_TIMEOUT_MS);
    }

    public override stop(): void {
        super.stop();
        this.clearOutputWatchdog();
        this.clearStallTimer();
        if (this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.decoder = this.createDecoder();
        this.configData = undefined;
        this.detectedCodec = null;
        this.needKeyframe = true;
    }
}
