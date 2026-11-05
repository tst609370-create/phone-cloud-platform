import type WS from 'ws';
import { ACTION } from '../common/Action';
import type { MicStatus } from '../common/micProtocol';
import { AdbClient } from './AdbClient';
import { Config } from './Config';
import { Logger } from './Logger';
import { type MicAdb, openLsposedMic, openShellMic } from './mic/deviceBridge';
import { probeMicFacts, resolveVirtualMicJar } from './mic/route';
import { MicTalkSession } from './mic/session';
import { Mw, type RequestParameters } from './mw/Mw';
import { isValidSerial } from './security/deviceInput';

const log = Logger.for('MicInject');
const MAX_PCM_BYTES = 64 * 1024;
const BUSY_REASON = '这台手机的麦克风正被另一个控制端使用';
const heldSerials = new Set<string>();

/**
 * Browser microphone → device microphone.
 *
 * The socket is already authenticated by WebSocketServer, and non-admin
 * renters only reach this action when `canAccessDevice` allows the serial.
 */
export class MicInject extends Mw {
    private readonly session: MicTalkSession;
    private readonly releaseSerial: () => void;

    public static override processRequest(ws: WS, params: RequestParameters): MicInject | undefined {
        if (params.action !== ACTION.MIC_INJECT) return undefined;
        const udid = params.url.searchParams.get('udid');
        if (!isValidSerial(udid)) {
            ws.close(4003, '[MicInject] Missing or invalid "udid"');
            return undefined;
        }
        return new MicInject(ws, udid);
    }

    private constructor(ws: WS, serial: string) {
        super(ws);
        const release = tryHoldSerial(serial);
        this.releaseSerial = release ?? (() => undefined);
        const adb = new AdbClient(Config.getInstance().adbPath);
        this.session = new MicTalkSession(serial, {
            probe: () =>
                release
                    ? probeMicFacts(adb, serial, resolveVirtualMicJar() !== undefined)
                    : Promise.reject(new Error(BUSY_REASON)),
            open: (route) => (release ? openRoute(adb, serial, route) : Promise.reject(new Error(BUSY_REASON))),
            onStatus: (status) => this.sendStatus(status),
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
        this.releaseSerial();
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

function tryHoldSerial(serial: string): (() => void) | undefined {
    if (heldSerials.has(serial)) return undefined;
    heldSerials.add(serial);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        heldSerials.delete(serial);
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
