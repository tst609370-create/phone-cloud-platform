import fs from 'fs';
import net from 'net';
import path from 'path';
import { PassThrough } from 'stream';
import type { RootAudioLog, RootAudioSession } from './rootAudio';

/**
 * No-root phone sound for Android 8-10: a tiny app (android/root-audio/app) whose
 * foreground service records the microphone while the phone plays out loud. The
 * adb shell user cannot record on these versions, an installed app with
 * RECORD_AUDIO can. Install, permission grants and start are all done over adb,
 * nobody has to touch the phone. The service serves the scrcpy-style audio stream
 * on an abstract socket that we reach with `adb forward`.
 */

export const MIC_APP_PKG = 'com.wsphone.micaudio';
export const MIC_APP_VERSION = 5;
const SERVICE = `${MIC_APP_PKG}/.MicService`;

/** Noise reduction for the mic app: off, normal (suppressor + gate at -48 dBFS), strong (-40). */
export type DenoiseLevel = 'off' | 'normal' | 'strong';
const denoiseBySerial = new Map<string, DenoiseLevel>();
export function getDenoise(serial: string): DenoiseLevel {
    return denoiseBySerial.get(serial) ?? 'normal';
}
export function denoiseExtras(level: DenoiseLevel): string {
    // normal: gate -48 dBFS, 100 Hz-8 kHz; strong: gate -40, 150 Hz-4.5 kHz (voice band).
    const gate = level === 'strong' ? -40 : level === 'normal' ? -48 : 0;
    const band = level === 'strong' ? '--es hp 150 --es lp 4500' : '--es hp 100 --es lp 8000';
    return `--es denoise ${level === 'off' ? 0 : 1} --es gate ${gate} ${band}`;
}
/** Remember the level and apply it live to a running mic app (no reconnect). */
export async function setDenoise(adb: Pick<MicAppAdb, 'shell'>, serial: string, level: DenoiseLevel): Promise<void> {
    denoiseBySerial.set(serial, level);
    await sh(
        adb as MicAppAdb,
        serial,
        `am start-foreground-service -n ${SERVICE} -a config ${denoiseExtras(level)} >/dev/null 2>&1`,
    );
}

export interface MicAppAdb {
    shell(serial: string, command: string, timeoutMs?: number): Promise<string>;
    install(serial: string, local: string): Promise<string>;
    forward(serial: string, local: string, remote: string): Promise<string>;
    removeForward(serial: string, local: string): Promise<void>;
}

export function resolveMicApk(exists: (file: string) => boolean = fs.existsSync): string | undefined {
    const candidates = [
        process.env['WS_MIC_APK'],
        path.join(__dirname, 'mic-audio.apk'),
        path.resolve(__dirname, '../android/root-audio/prebuilt/mic-audio.apk'),
        path.resolve(__dirname, '../../../android/root-audio/prebuilt/mic-audio.apk'),
        path.resolve(process.cwd(), 'android/root-audio/prebuilt/mic-audio.apk'),
    ];
    for (const candidate of candidates) {
        if (candidate && exists(candidate)) return candidate;
    }
    return undefined;
}

/** Shell output even when the command fails (adb shell passes the exit code on). */
async function sh(adb: MicAppAdb, serial: string, command: string, timeoutMs = 10_000): Promise<string> {
    try {
        return (await adb.shell(serial, `${command}; true`, timeoutMs)).trim();
    } catch (e) {
        const cause = (e as { cause?: { stderr?: string; stdout?: string } }).cause;
        return (
            `${cause?.stdout ?? ''} ${cause?.stderr ?? ''}`.trim() || (e as Error).message.replace(/\(path=[^)]*\)/, '')
        );
    }
}

export function installedVersion(dumpsys: string): number {
    const m = /versionCode=(\d+)/.exec(dumpsys);
    return m ? Number(m[1]) : 0;
}

/** Install or upgrade the app and grant what it needs. Returns a problem, or '' when ready. */
export async function ensureMicApp(adb: MicAppAdb, serial: string, apk: string): Promise<string> {
    const have = installedVersion(await sh(adb, serial, `dumpsys package ${MIC_APP_PKG} | grep versionCode`));
    if (have < MIC_APP_VERSION) {
        let res = '';
        try {
            res = await adb.install(serial, apk);
        } catch (e) {
            const cause = (e as { cause?: { stderr?: string; stdout?: string } }).cause;
            res = `${cause?.stdout ?? ''} ${cause?.stderr ?? ''} ${(e as Error).message}`;
        }
        if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(res)) {
            await sh(adb, serial, `pm uninstall ${MIC_APP_PKG}`);
            try {
                res = await adb.install(serial, apk);
            } catch (e) {
                res = (e as Error).message;
            }
        }
        if (!/Success/.test(res)) {
            const why = res
                .replace(/\(path=[^)]*\)/, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 160);
            const miui = /INSTALL_FAILED_USER_RESTRICTED|USER_RESTRICTED/i.test(res)
                ? '。小米手机要在「开发者选项」打开「USB 安装」（需插 SIM 卡并登录小米账号）'
                : '';
            return `录音小程序装不上：${why}${miui}`;
        }
    }
    const miui = (await sh(adb, serial, 'getprop ro.miui.ui.version.name')).length > 0;
    const grants = [
        `pm grant ${MIC_APP_PKG} android.permission.RECORD_AUDIO`,
        `appops set ${MIC_APP_PKG} RECORD_AUDIO allow`,
        `dumpsys deviceidle whitelist +${MIC_APP_PKG} >/dev/null`,
    ];
    // MIUI's own switches: 后台弹出界面 (10021), 自启动 (10008).
    if (miui) grants.push(`appops set ${MIC_APP_PKG} 10021 allow`, `appops set ${MIC_APP_PKG} 10008 allow`);
    grants.push(`cmd appops set ${MIC_APP_PKG} RUN_IN_BACKGROUND allow`);
    await sh(adb, serial, grants.join('; '), 15_000);
    // MIUI can drop a pm grant silently: check what the phone really says.
    const state = micPermissionState(
        await sh(
            adb,
            serial,
            `dumpsys package ${MIC_APP_PKG} | grep RECORD_AUDIO; echo __OPS; appops get ${MIC_APP_PKG} RECORD_AUDIO`,
        ),
    );
    if (!state.granted || state.op === 'deny' || state.op === 'ignore') {
        return `「手机声音」App 没拿到录音权限（录音权限：${state.granted ? '已授予' : '没授予'}，录音开关：${state.op || '未知'}）。小米手机请确认开发者选项里「USB 调试（安全设置）」已打开，再点重连；还不行就在手机桌面点开「手机声音」，点「去授权」允许录音`;
    }
    return '';
}

/** Parse `dumpsys package … | grep RECORD_AUDIO; echo __OPS; appops get … RECORD_AUDIO`. */
export function micPermissionState(out: string): { granted: boolean; op: string } {
    const [pkg = '', ops = ''] = out.split('__OPS');
    const granted = /RECORD_AUDIO: granted=true/.test(pkg);
    const m = /RECORD_AUDIO: (allow|ignore|deny|default|foreground)/.exec(ops);
    return { granted, op: m ? m[1]! : '' };
}

/** Read the first 4 bytes (codec id) within `ms`, keeping anything after it on the socket. */
function readHeader(sock: net.Socket, ms: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const done = (err?: Error) => {
            clearTimeout(timer);
            sock.removeListener('data', onData);
            sock.removeListener('close', onClose);
            sock.removeListener('error', onClose);
            if (err) reject(err);
        };
        const onData = (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            if (buf.length >= 4) {
                done();
                resolve(buf);
            }
        };
        const onClose = () => done(new Error('closed'));
        const timer = setTimeout(() => done(new Error('timeout')), ms);
        sock.on('data', onData);
        sock.once('close', onClose);
        sock.once('error', onClose);
    });
}

/** AUDIO_ERROR (1) + int length + UTF-8 reason, as RootAudioMain.stream writes it. */
export function parseErrorReason(buf: Buffer): string | undefined {
    if (buf.length < 4 || buf.readUInt32BE(0) !== 1) return undefined;
    if (buf.length < 8) return '';
    const len = buf.readUInt32BE(4);
    return buf.subarray(8, 8 + Math.min(len, 400)).toString('utf-8');
}

function connect(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const s = net.createConnection({ host: '127.0.0.1', port }, () => resolve(s));
        s.once('error', reject);
    });
}

/**
 * Install/grant/start the app and connect to its stream. Never throws: failures
 * resolve `socket` to undefined and `lastError()` says why in the phone's words.
 */
export async function startMicApp(
    adb: MicAppAdb,
    serial: string,
    scid: string,
    codec: 'aac' | 'raw',
    apk: string,
    log: RootAudioLog,
    connectTimeoutMs = 12_000,
): Promise<RootAudioSession> {
    let lastError = '';
    let forwarded: string | undefined;
    let sock: net.Socket | undefined;
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        sock?.destroy();
        // Make the app release the microphone and drop its notification even if the
        // closed socket goes unnoticed on the phone.
        sh(
            adb,
            serial,
            `am start-foreground-service -n ${SERVICE} -a stop --es socket wsmic_${scid} >/dev/null 2>&1`,
        ).catch(() => undefined);
        if (forwarded) adb.removeForward(serial, forwarded).catch(() => undefined);
    };
    const fail = (why: string): RootAudioSession => {
        lastError = why;
        log.info(`mic app for ${serial}: ${why}`);
        return { socket: Promise.resolve(undefined), lastError: () => lastError, stop };
    };

    const problem = await ensureMicApp(adb, serial, apk);
    if (problem) return fail(problem);

    const name = `wsmic_${scid}`;
    const started = await sh(
        adb,
        serial,
        `am start-foreground-service -n ${SERVICE} --es socket ${name} --es codec ${codec} ${denoiseExtras(getDenoise(serial))} 2>&1`,
        10_000,
    );
    if (/Error|Exception|not allowed|Unable/i.test(started))
        return fail(`录音小程序启动失败：${started.replace(/\s+/g, ' ').slice(0, 160)}`);

    // Pick a free local port, then forward it to the app's abstract socket.
    const port = await new Promise<number>((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const p = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(p));
        });
    });
    forwarded = `tcp:${port}`;
    try {
        await adb.forward(serial, forwarded, `localabstract:${name}`);
    } catch (e) {
        return fail(`adb forward 失败：${(e as Error).message.replace(/\(path=[^)]*\)/, '').slice(0, 120)}`);
    }

    // adb accepts the TCP connection before the app is listening: retry until it talks.
    const socket = (async (): Promise<net.Socket | undefined> => {
        const until = Date.now() + connectTimeoutMs;
        while (!stopped && Date.now() < until) {
            let s: net.Socket | undefined;
            try {
                s = await connect(port);
                const head = await readHeader(s, 1_500);
                const reason = parseErrorReason(head);
                if (reason !== undefined) {
                    // Wait a moment for the rest of the reason text.
                    let more = head;
                    await new Promise<void>((r) => {
                        s!.resume();
                        s!.on('data', (c: Buffer) => (more = Buffer.concat([more, c])));
                        setTimeout(r, 300);
                    });
                    lastError = parseErrorReason(more) || '录音失败（麦克风被占用或没有权限）';
                    s.destroy();
                    return undefined;
                }
                // Hand over a stream that starts with the bytes already read.
                const real = s;
                const pt = new PassThrough();
                pt.write(head);
                real.on('data', (c: Buffer) => pt.write(c));
                real.on('close', () => pt.end());
                real.on('error', () => pt.end());
                pt.on('close', () => real.destroy());
                const wrapped = pt as unknown as net.Socket;
                (wrapped as unknown as { destroy: () => void }).destroy = () => {
                    real.destroy();
                    PassThrough.prototype.destroy.call(pt);
                };
                sock = wrapped;
                if (stopped) real.destroy();
                return wrapped;
            } catch {
                s?.destroy();
                await new Promise((r) => setTimeout(r, 300));
            }
        }
        if (!lastError) lastError = '录音小程序没有响应（可能被系统省电/自启动管理拦了）';
        return undefined;
    })();
    socket.then((s) => log.info(`mic app for ${serial}: ${s ? 'streaming' : lastError}`)).catch(() => undefined);
    return { socket, lastError: () => lastError, stop };
}
