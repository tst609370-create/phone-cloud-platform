import crypto from 'crypto';
import net from 'net';
import path from 'path';
import type WS from 'ws';
import { ACTION } from '../common/Action';
import { playbackAudioBlockReason } from '../common/AudioDefaults';
import { ChannelId, type StreamNetStats } from '../common/ChannelId';
import { DEVICE_SERVER_PATH, SERVER_PACKAGE } from '../common/Constants';
import { AdbClient } from './AdbClient';
import { Config } from './Config';
import { ensureScrcpyServerPushed } from './ensureScrcpyServerPushed';
import { ControlCenter } from './goog-device/services/ControlCenter';
import { Logger } from './Logger';
import { Mw, type RequestParameters } from './mw/Mw';
import {
    probeRoot,
    ROOT_AUDIO_FAILED,
    ROOT_AUDIO_MIN_SDK,
    type RootAudioSession,
    resolveRootAudioJar,
    startRootAudio,
} from './rootAudio';
import { type ScrcpyOptions, serializeOptions } from './ScrcpyOptions';
import { acceptScrcpy41Control } from './scrcpy41';
import { pipeScrcpySockets } from './scrcpyMedia';
import { scrcpyOptionsFromQuery } from './scrcpyOptionsFromQuery';
import { getInstalledScrcpyServerVersion } from './scrcpyServerVersion';
import { ackedThresholds, RESET_VIDEO_MESSAGE, StreamNetMeter, VideoBackpressure } from './videoBackpressure';
import { capKey, clampMaxSize, defaultCapForModel } from './videoSizeCap';

const log = Logger.for('ScrcpyConnection');

/**
 * v0.1.9: scrcpy-server lives in <deps>/scrcpy-server/, managed by
 * DependencyManager. See DeviceProbe.serverFile() for the full
 * rationale.
 */
function serverFile(): string {
    return path.join(Config.getInstance().dependenciesPath, 'scrcpy-server', 'scrcpy-server');
}

function installedVersion(): string {
    return getInstalledScrcpyServerVersion(Config.getInstance().dependenciesPath);
}

export class ScrcpyConnection extends Mw {
    /** Flags on the browser websocket. The demuxer still reads config at bit 63. */
    private static readonly PTS_FLAG_CONFIG = 0x8000000000000000n;
    private static readonly PTS_FLAG_KEYFRAME = 0x4000000000000000n;

    private adbClient = new AdbClient(Config.getInstance().adbPath);
    private tcpServer?: net.Server;
    private videoSocket?: net.Socket;
    private audioSocket?: net.Socket;
    private rootAudio?: RootAudioSession;
    private controlSocket?: net.Socket;
    private reverseTunnel?: string;
    private forwardTunnel?: string;
    private serverProcess?: import('child_process').ChildProcess;
    private released = false;
    private readonly backpressure = new VideoBackpressure();
    private readonly net = new StreamNetMeter();
    private statsTimer: NodeJS.Timeout | undefined;
    private videoBitRate = 0;

    public static override processRequest(ws: WS, params: RequestParameters): ScrcpyConnection | undefined {
        const { action, url } = params;
        if (action !== ACTION.STREAM_SCRCPY) {
            return;
        }
        const udid = url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, '[ScrcpyConnection] Missing "udid" parameter');
            return;
        }
        const connection = new ScrcpyConnection(ws, udid, url.searchParams);
        return connection;
    }

    private constructor(
        ws: WS,
        private readonly serial: string,
        private readonly queryParams: URLSearchParams,
    ) {
        super(ws);
        this.start().catch((err) => {
            log.error(`Failed to start session for ${serial}:`, err.message);
            try {
                if (ws.readyState === ws.OPEN) {
                    ws.close(4005, err.message.slice(0, 123));
                }
            } catch (closeErr) {
                log.error(`Failed to close WebSocket for ${serial}:`, closeErr);
            }
        });
    }

    private buildOptions(): ScrcpyOptions {
        const scid = crypto.randomInt(0, 0x7fffffff).toString(16).padStart(8, '0');
        const options = scrcpyOptionsFromQuery(this.queryParams, scid);
        const cap = this.videoSizeCap();
        const clamped = clampMaxSize(options.maxSize, cap);
        if (clamped !== options.maxSize) {
            log.info(
                `max_size ${options.maxSize || 0} → ${clamped} for ${this.serial} (this phone goes black above ${cap})`,
            );
            if (clamped !== undefined) options.maxSize = clamped;
        }
        return options;
    }

    private videoSizeCap(): number {
        let stored = 0;
        try {
            stored = Number(Config.getInstance().db.appSettings.get(capKey(this.serial))) || 0;
        } catch {
            /* no db in tests */
        }
        let model: string | undefined;
        try {
            if (ControlCenter.hasInstance()) {
                model = ControlCenter.getInstance().getDevice(this.serial)?.descriptor['ro.product.model'];
            }
        } catch {
            /* device list not ready */
        }
        const known = defaultCapForModel(model);
        if (stored > 0 && known > 0) return Math.min(stored, known);
        return stored || known;
    }

    private async start(): Promise<void> {
        const options = this.buildOptions();

        // SDK-gated behavior for older Android devices:
        //  - Reverse-over-TCP is unreliable on pre-9 (SDK 28); those devices need
        //    tunnel_forward=true with host-initiated connections instead.
        //  - scrcpy audio forwarding requires Android 11+ (SDK 30); force audio off
        //    on older devices so the server doesn't refuse to start.
        //  - scrcpy-server self-deletes its own JAR at startup by default. On pre-8
        //    Android (ART class loading is lazier), the JAR vanishes before the
        //    server class fully resolves and app_process aborts with
        //    ClassNotFoundException. cleanup=false keeps the JAR around.
        const sdkInt = await this.getSdkInt();
        const useTunnelForward = sdkInt > 0 && sdkInt < 28;
        // Audio-capture gates:
        //  * SDK<30: scrcpy can't capture audio at all.
        //  * SDK<33 with explicit audio_source=playback: --audio-dup requires
        //    Android 13+; without it the device would be silenced anyway so the
        //    user's opt-in to "keep device audio" can't be honored — force off
        //    rather than surprise them with silence.
        //  (Default source is `output`, which works on every audio-capable SDK.)
        const requestedAudio = options.audio !== false;
        let audioBlock = requestedAudio ? playbackAudioBlockReason(sdkInt) : undefined;
        // Android 8-10 with root: scrcpy still runs without audio, and a helper
        // under su records the device output instead (see rootAudio.ts).
        let rootAudioJar: string | undefined;
        let rootPrefix = '';
        if (audioBlock && sdkInt >= ROOT_AUDIO_MIN_SDK) {
            const jar = resolveRootAudioJar();
            const probe = jar ? await probeRoot(this.adbClient, this.serial, Date.now(), log) : undefined;
            if (jar && probe?.prefix !== undefined) {
                rootAudioJar = jar;
                rootPrefix = probe.prefix;
                audioBlock = undefined;
            } else if (probe?.reason) {
                audioBlock = `Android API ${sdkInt} 低于 11，要 ROOT 才能听手机声音：${probe.reason}`;
            }
        }
        if (audioBlock || rootAudioJar) {
            options.audio = false;
        } else if (sdkInt > 0 && sdkInt < 33 && options.audioSource === 'playback') {
            // playback capture needs Android 13+: use the whole-output source instead
            // of going silent (the browser may ask for playback after hearing silence).
            options.audioSource = 'output';
            options.audioDup = false;
        }
        if (useTunnelForward) {
            options.tunnelForward = true;
            options.cleanup = false;
        }
        log.info(
            `Starting session for ${this.serial} (scid=${options.scid}, sdk=${sdkInt || '?'}, tunnel=${useTunnelForward ? 'forward' : 'reverse'}, audio=${options.audio ?? 'default'}, cleanup=${options.cleanup ?? 'default'})`,
        );

        // 1. Push scrcpy-server binary only when the remote copy is missing or
        //    a different size. Keeping the JAR in place between sessions keeps
        //    Android's dexopt cache warm and drops ~15s off cold-start on older
        //    devices.
        await ensureScrcpyServerPushed(this.adbClient, this.serial, serverFile());
        if (rootAudioJar) {
            const codec = options.audioCodec === 'raw' ? 'raw' : 'aac';
            this.rootAudio = await startRootAudio(
                this.adbClient,
                this.serial,
                String(options.scid),
                codec,
                rootAudioJar,
                log,
                10_000,
                rootPrefix,
            );
            log.info(
                `root audio capture requested for ${this.serial} (sdk=${sdkInt}, codec=${codec}, via="${rootPrefix || 'adb shell'}")`,
            );
        }

        // 2. Set up tunnel + launch scrcpy-server + collect 3 sockets.
        const sockets = useTunnelForward
            ? await this.startWithForwardTunnel(options)
            : await this.startWithReverseTunnel(options);
        this.videoSocket = sockets[0]!;
        this.audioSocket = sockets[1]!;
        this.controlSocket = sockets[2]!;
        // Touch events are tiny writes; with Nagle on (Node's default) a move
        // can wait for the previous write's ACK — Windows delays ACKs up to
        // 200 ms — which makes dragging feel sticky.
        for (const s of sockets) s?.setNoDelay?.(true);
        this.videoBitRate = options.videoBitRate ?? 0;
        this.startStats();
        if (this.rootAudio) {
            const rootSocket = await this.rootAudio.socket;
            if (rootSocket) {
                this.audioSocket.destroy();
                this.audioSocket = rootSocket;
            } else {
                const err = this.rootAudio.lastError();
                audioBlock = err ? `${ROOT_AUDIO_FAILED}。手机端报错：${err}` : ROOT_AUDIO_FAILED;
            }
        }

        log.info(`Reading video before audio for ${this.serial}`);
        await pipeScrcpySockets(
            this.videoSocket,
            this.audioSocket,
            this.controlSocket,
            requestedAudio,
            audioBlock,
            {
                onMetadata: (meta) => {
                    if (options.videoEncoder) meta.videoEncoder = options.videoEncoder;
                    this.sendChannel(ChannelId.METADATA, Buffer.from(JSON.stringify(meta)));
                },
                onVideoFrame: (frame) => {
                    let pts = frame.pts;
                    if (frame.type === 'config') pts |= ScrcpyConnection.PTS_FLAG_CONFIG;
                    else if (frame.type === 'keyframe') pts |= ScrcpyConnection.PTS_FLAG_KEYFRAME;
                    const header = Buffer.alloc(12);
                    header.writeBigUInt64BE(pts, 0);
                    header.writeUInt32BE(frame.data.length, 8);
                    const kind = frame.type === 'config' ? 'config' : frame.type === 'keyframe' ? 'keyframe' : 'delta';
                    const wasDropping = this.backpressure.isDropping;
                    const decision = this.backpressure.video(kind, this.backlog(), Date.now());
                    if (decision.requestKeyframe) this.requestKeyframe();
                    if (!wasDropping && this.backpressure.isDropping) {
                        log.info(
                            `network behind for ${this.serial} (${this.backlog()} bytes queued); skipping frames until it catches up`,
                        );
                    }
                    if (!decision.send) return;
                    if (this.sendChannel(ChannelId.VIDEO, Buffer.concat([header, frame.data]))) {
                        this.net.onSent(1 + header.length + frame.data.length);
                    }
                },
                onAudioFrame: (frame) => {
                    let pts = frame.pts;
                    if (frame.type === 'config') pts |= ScrcpyConnection.PTS_FLAG_CONFIG;
                    const header = Buffer.alloc(12);
                    header.writeBigUInt64BE(pts, 0);
                    header.writeUInt32BE(frame.data.length, 8);
                    if (frame.type !== 'config' && !this.backpressure.audio(this.backlog())) return;
                    this.sendChannel(ChannelId.AUDIO, Buffer.concat([header, frame.data]));
                },
                onControl: (data) => this.sendChannel(ChannelId.DEVICE_MSG, data),
                onVideoEnd: () => this.release(),
            },
            undefined,
            this.rootAudio
                ? () => {
                      const err = this.rootAudio?.lastError();
                      return err ? `${ROOT_AUDIO_FAILED}。手机端报错：${err}` : ROOT_AUDIO_FAILED;
                  }
                : undefined,
        );
    }

    private async getSdkInt(): Promise<number> {
        // Prefer the value cached on the descriptor by ControlCenter's poll —
        // saves an adb-shell round-trip per session start.
        if (ControlCenter.hasInstance()) {
            const device = ControlCenter.getInstance().getDevice(this.serial);
            const raw = device?.descriptor['ro.build.version.sdk'];
            if (raw) {
                const n = Number.parseInt(raw, 10);
                if (Number.isFinite(n) && n > 0) return n;
            }
        }
        try {
            const out = await this.adbClient.shell(this.serial, 'getprop ro.build.version.sdk');
            const n = Number.parseInt(out.trim(), 10);
            return Number.isFinite(n) ? n : 0;
        } catch {
            return 0;
        }
    }

    private async startWithReverseTunnel(options: ScrcpyOptions): Promise<net.Socket[]> {
        // Host listens on an ephemeral port; adb reverses device's localabstract
        // socket to that port. scrcpy-server connects out (3 sockets) — we accept.
        const { server, port } = await this.createTcpServer();
        this.tcpServer = server;
        this.reverseTunnel = `localabstract:scrcpy_${options.scid}`;
        await this.adbClient.reverse(this.serial, this.reverseTunnel, `tcp:${port}`);

        this.launchServer(options);

        const audioEnabled = options.audio !== false;
        const sockets = await this.acceptSockets(server, audioEnabled ? 3 : 2, 10000);
        if (audioEnabled) return sockets;

        // With audio disabled scrcpy connects video then control. Keep the
        // internal three-slot shape by inserting a synthetic disabled-audio
        // socket between them.
        const audioSocket = new net.Socket();
        audioSocket.unshift(Buffer.from([0x00, 0x00, 0x00, 0x00]));
        return [sockets[0]!, audioSocket, sockets[1]!];
    }

    private async startWithForwardTunnel(options: ScrcpyOptions): Promise<net.Socket[]> {
        // adb forwards a host port to scrcpy-server's localabstract socket. The
        // server binds and listens (because tunnel_forward=true); host initiates
        // the 2 or 3 client connections through the forward.
        //
        // IMPORTANT: adb-forward accepts host-side TCP connections eagerly even
        // before the device-side socket is bound. A successful connect() does
        // NOT mean scrcpy-server is actually ready. We detect real readiness by
        // waiting for scrcpy's dummy 0x00 byte on the first socket (scrcpy v3
        // writes it on exactly one socket, video-first). If no byte arrives in
        // a short window, the connection is stale — close it and retry. This
        // matches what the upstream scrcpy client does.
        const localPort = await this.reserveLocalPort();
        this.forwardTunnel = `tcp:${localPort}`;
        const remote = `localabstract:scrcpy_${options.scid}`;
        await this.adbClient.forward(this.serial, this.forwardTunnel, remote);

        this.launchServer(options);

        log.info(`Waiting for scrcpy-server handshake on ${this.serial} (up to 120s)...`);
        const videoSocket = await this.connectAndAwaitDummy(localPort, 120000);
        log.info(`scrcpy-server is live on ${this.serial}; opening remaining sockets`);

        // scrcpy accepts in order: video → audio (if enabled) → control. Give it
        // a brief beat between connects so each accept/return cycle completes.
        const audioEnabled = options.audio !== false;
        await new Promise((r) => setTimeout(r, 100));
        let audioSocket: net.Socket;
        if (audioEnabled) {
            audioSocket = await this.connectLocal(localPort, 15000);
            await new Promise((r) => setTimeout(r, 100));
        } else {
            // audio=false means scrcpy-server skips the audio accept. Feed
            // parseMetadata a synthetic AUDIO_DISABLED 4-byte status so the rest
            // of the pipeline keeps the same shape without needing a special case.
            audioSocket = new net.Socket();
            audioSocket.unshift(Buffer.from([0x00, 0x00, 0x00, 0x00])); // AUDIO_DISABLED (0x00000000) sentinel
        }
        const controlSocket = await this.connectLocal(localPort, 15000);

        return [videoSocket, audioSocket, controlSocket];
    }

    private async connectAndAwaitDummy(port: number, maxWaitMs: number): Promise<net.Socket> {
        // Open a TCP connection to the adb-forward, then try to read 1 byte
        // with a short per-attempt timeout. If the byte arrives, scrcpy-server
        // is alive and this is the video socket. If the read times out, adb
        // accepted us but the device side isn't bound yet — close the socket
        // and retry. The per-attempt timeout is deliberate on Windows: adb
        // forward silently holds the TCP connection when device-side isn't
        // bound (no error surfaces), so we can't rely on scrcpy's "just block
        // on recv" pattern; we need to recycle sockets to kick adb into
        // re-attempting the device-side connection.
        const deadline = Date.now() + maxWaitMs;
        let lastErr: Error | null = null;
        while (Date.now() < deadline) {
            let sock: net.Socket | undefined;
            try {
                sock = await this.connectLocal(port, 2000);
                const byte = await this.readExactWithTimeout(sock, 1, 2000);
                log.info(`Received handshake byte 0x${byte[0]!.toString(16).padStart(2, '0')} on ${this.serial}`);
                return sock;
            } catch (e) {
                lastErr = e as Error;
                try {
                    sock?.destroy();
                } catch {
                    // ignore
                }
                await new Promise((r) => setTimeout(r, 150));
            }
        }
        throw lastErr ?? new Error(`scrcpy-server did not emit handshake byte within ${maxWaitMs}ms`);
    }

    private readExactWithTimeout(socket: net.Socket, size: number, timeoutMs: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.removeListener('data', onData);
                socket.removeListener('error', onError);
                reject(new Error(`readExact timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            let buffer = Buffer.alloc(0);
            const onData = (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                if (buffer.length >= size) {
                    clearTimeout(timer);
                    socket.removeListener('data', onData);
                    socket.removeListener('error', onError);
                    if (buffer.length > size) socket.unshift(buffer.subarray(size));
                    resolve(buffer.subarray(0, size));
                }
            };
            const onError = (err: Error) => {
                clearTimeout(timer);
                socket.removeListener('data', onData);
                reject(err);
            };
            socket.on('data', onData);
            socket.once('error', onError);
        });
    }

    private launchServer(options: ScrcpyOptions): void {
        const args = serializeOptions(options);
        const cmd = `CLASSPATH=${DEVICE_SERVER_PATH} app_process / ${SERVER_PACKAGE} ${installedVersion()} ${args.join(' ')}`;
        this.serverProcess = this.adbClient.shellSpawn(this.serial, cmd);
        // Tee scrcpy-server's stdout/stderr into our log so its failure reason is visible.
        const logLine = (stream: 'stdout' | 'stderr', data: Buffer) => {
            const text = data.toString('utf-8').trimEnd();
            if (text) log.info(`[scrcpy-server:${stream}] ${this.serial}: ${text}`);
        };
        this.serverProcess.stdout?.on('data', (d) => logLine('stdout', d));
        this.serverProcess.stderr?.on('data', (d) => logLine('stderr', d));
        this.serverProcess.on('exit', (code, signal) => {
            log.info(`Server process exited for ${this.serial} (code=${code}, signal=${signal})`);
            if (!this.released) {
                this.release();
            }
        });
    }

    private createTcpServer(): Promise<{ server: net.Server; port: number }> {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address() as net.AddressInfo;
                resolve({ server, port: addr.port });
            });
            server.on('error', reject);
        });
    }

    private async reserveLocalPort(): Promise<number> {
        // Bind briefly to learn a free port, release it so adb forward can take it.
        // Brief race on localhost is acceptable — ephemeral ports rarely collide.
        const { server, port } = await this.createTcpServer();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return port;
    }

    private connectLocal(port: number, timeoutMs: number): Promise<net.Socket> {
        return new Promise((resolve, reject) => {
            const sock = net.createConnection({ host: '127.0.0.1', port });
            const timer = setTimeout(() => {
                sock.destroy();
                reject(new Error(`Timeout connecting to 127.0.0.1:${port}`));
            }, timeoutMs);
            sock.once('connect', () => {
                clearTimeout(timer);
                resolve(sock);
            });
            sock.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    private acceptSockets(server: net.Server, count: number, timeoutMs: number): Promise<net.Socket[]> {
        return new Promise((resolve, reject) => {
            const sockets: net.Socket[] = [];
            const timeout = setTimeout(() => {
                server.removeAllListeners('connection');
                reject(new Error(`Timeout waiting for ${count} TCP connections (got ${sockets.length})`));
            }, timeoutMs);

            server.on('connection', (socket) => {
                sockets.push(socket);
                if (sockets.length === count) {
                    clearTimeout(timeout);
                    resolve(sockets);
                }
            });
        });
    }

    private requestKeyframe(): void {
        if (this.controlSocket && !this.controlSocket.destroyed) this.controlSocket.write(RESET_VIDEO_MESSAGE);
    }

    private sendChannel(channel: ChannelId, payload: Buffer): boolean {
        if (this.ws.readyState !== this.ws.OPEN) return false;
        const msg = Buffer.allocUnsafe(1 + payload.length);
        msg[0] = channel;
        payload.copy(msg, 1);
        this.ws.send(msg);
        return true;
    }

    /** Video still on its way to the browser: end to end once it acknowledges frames. */
    private backlog(): number {
        return this.net.ackSeen ? this.net.inflight : this.ws.bufferedAmount;
    }

    private onAck(payload: Buffer): void {
        if (payload.length < 16) return;
        const firstAck = !this.net.ackSeen;
        this.net.onAck(payload.readDoubleBE(0), payload.readDoubleBE(8), Date.now());
        if (firstAck) {
            const t = ackedThresholds(this.videoBitRate);
            this.backpressure.setThresholds(t.highWater, t.lowWater);
        }
        if (this.backpressure.drained(this.net.inflight, Date.now())) this.requestKeyframe();
    }

    private startStats(): void {
        if (this.statsTimer) return;
        this.statsTimer = setInterval(() => {
            const now = Date.now();
            this.net.tick(now, this.backpressure.isDropping);
            // Old cached pages don't understand STATS/ACK; they ignore unknown channels.
            const stats: StreamNetStats = {
                t: now,
                rttMs: this.net.rttMs,
                inflight: this.net.ackSeen ? this.net.inflight : this.ws.bufferedAmount,
                goodputKbps: this.net.goodputKbps,
                bitrate: this.videoBitRate,
                dropped: this.backpressure.droppedFrames,
                episodes: this.backpressure.episodes,
                capacityKbps: this.net.capacityKbps,
            };
            this.sendChannel(ChannelId.STATS, Buffer.from(JSON.stringify(stats)));
        }, 1000);
        this.statsTimer.unref?.();
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        // Browser → server: control messages on channel 2
        if (event.data instanceof Buffer || event.data instanceof ArrayBuffer) {
            const data = Buffer.from(event.data as ArrayBuffer);
            if (data.length < 2) return;
            const channel = data[0];
            const payload = data.subarray(1);
            if (channel === ChannelId.ACK) {
                this.onAck(payload);
                return;
            }
            if (channel === ChannelId.CONTROL && this.controlSocket && !this.controlSocket.destroyed) {
                if (!acceptScrcpy41Control(payload)) {
                    log.info(`ignored control type ${payload[0]} because scrcpy 4.1 would close the control channel`);
                    return;
                }
                this.controlSocket.write(payload);
            }
        }
    }

    public override release(): void {
        if (this.released) return;
        this.released = true;
        log.info(`Releasing session for ${this.serial}`);
        if (this.statsTimer) clearInterval(this.statsTimer);
        this.statsTimer = undefined;

        this.videoSocket?.destroy();
        this.audioSocket?.destroy();
        this.controlSocket?.destroy();
        this.rootAudio?.stop();

        if (this.serverProcess && !this.serverProcess.killed) {
            this.serverProcess.kill();
        }

        if (this.reverseTunnel) {
            this.adbClient.removeReverse(this.serial, this.reverseTunnel).catch(() => {});
        }
        if (this.forwardTunnel) {
            this.adbClient.removeForward(this.serial, this.forwardTunnel).catch(() => {});
        }

        this.tcpServer?.close();
        super.release();
    }
}
