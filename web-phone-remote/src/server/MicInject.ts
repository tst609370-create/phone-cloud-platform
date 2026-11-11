import type WS from 'ws';
import { ACTION } from '../common/Action';
import { MIC_BUSY_REASON, type MicStatus } from '../common/micProtocol';
import { AdbClient } from './AdbClient';
import { Config } from './Config';
import { Logger } from './Logger';
import { type MicAdb, openLsposedMic, openShellMic, probeDeviceMic } from './mic/deviceBridge';
import { claimMicOwner } from './mic/owner';
import { resolveVirtualMicJar } from './mic/route';
import { MicTalkSession } from './mic/session';
import { Mw, type RequestParameters } from './mw/Mw';
import { isValidSerial } from './security/deviceInput';

const log = Logger.for('MicInject');
const MAX_PCM_BYTES = 64 * 1024;

/**
 * Browser microphone → device microphone.
 *
 * The socket is already authenticated by WebSocketServer, and non-admin
 * renters only reach this action when `canAccessDevice` allows the serial.
 */
export class MicInject extends Mw {
    private readonly session: MicTalkSession;
    private releaseOwner: (() => void) | undefined;

    public static override processRequest(ws: WS, params: RequestParameters): MicInject | undefined {
        if (params.action !== ACTION.MIC_INJECT) return undefined;
        const udid = params.url.searchParams.get('udid');
        if (!isValidSerial(udid)) {
            ws.close(4003, '[MicInject] Missing or invalid "udid"');
            return undefined;
        }
        return new MicInject(ws, udid);
    }

    private constructor(ws: WS, private readonly serial: string) {
        super(ws);
        const adb = new AdbClient(Config.getInstance().adbPath);
        this.session = new MicTalkSession(serial, {
            probe: () => probeDeviceMic(adb, serial, resolveVirtualMicJar()),
            open: (route) => openRoute(adb, serial, route),
            onStatus: (status) => {
                if (this.releaseOwner && !status.supported) {
                    this.releaseOwner();
                    this.releaseOwner = undefined;
                }
                this.sendStatus(status);
            },
        });
        void this.session.announce().catch((err) => {
            log.warn(`announce failed for ${serial}: ${err instanceof Error ? err.message : err}`);
        });
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        const data = event.data;
        if (typeof data === 'string') {
            this.onText(data);
            return;
        }
        const bytes = toBytes(data);
        if (bytes) void this.session.write(bytes);
    }

    protected override onSocketClose(): void {
        this.releaseOwner?.();
        this.releaseOwner = undefined;
        void this.session.close();
        super.onSocketClose();
    }

    private onText(raw: string): void {
        let msg: unknown;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        if (!msg || typeof msg !== 'object') return;
        const type = (msg as { type?: unknown }).type;
        if (type === 'start') {
            if (!this.releaseOwner) {
                const release = claimMicOwner(this.serial, () => this.ws.readyState === this.ws.OPEN);
                if (!release) {
                    this.sendStatus(busyStatus());
                    return;
                }
                this.releaseOwner = release;
            }
            void this.session.begin();
            return;
        }
        if (type === 'stop') {
            void this.session.end();
            return;
        }
        if (type === 'format') {
            const rate = (msg as { sampleRate?: unknown }).sampleRate;
            if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 8000 && rate <= 192000) {
                this.session.setInputRate(rate);
            }
        }
    }

    private sendStatus(status: MicStatus): void {
        if (this.ws.readyState !== this.ws.OPEN) return;
        this.ws.send(JSON.stringify(status));
    }
}

function busyStatus(): MicStatus {
    return {
        type: 'status',
        supported: false,
        route: 'none',
        routes: [],
        reason: MIC_BUSY_REASON,
        active: false,
        rooted: false,
        bridgeInstalled: false,
        sdkInt: 0,
    };
}

async function openRoute(adb: MicAdb, serial: string, route: 'lsposed' | 'shell') {
    if (route === 'lsposed') return openLsposedMic(adb, serial);
    const jar = resolveVirtualMicJar();
    if (!jar) throw new Error('服务端缺少 virtual-mic.jar');
    return openShellMic(adb, serial, jar);
}

function toBytes(data: unknown): Uint8Array | undefined {
    if (Buffer.isBuffer(data)) {
        if (data.byteLength > MAX_PCM_BYTES) return undefined;
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof ArrayBuffer) {
        if (data.byteLength > MAX_PCM_BYTES) return undefined;
        return new Uint8Array(data);
    }
    if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
        const joined = Buffer.concat(data);
        if (joined.byteLength > MAX_PCM_BYTES) return undefined;
        return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
    }
    return undefined;
}
