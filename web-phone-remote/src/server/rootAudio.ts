import type { ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

/**
 * Phone playback sound for Android 8-10 phones that have root.
 *
 * scrcpy can only capture audio on Android 11+. On older rooted phones we run
 * android/root-audio (RootAudioMain) under `su`: it records REMOTE_SUBMIX as
 * uid 0 and writes the same codec-id + packet stream scrcpy writes on its audio
 * socket, so the rest of the pipeline treats it as the scrcpy audio socket.
 * The helper connects out to an abstract socket that `adb reverse` maps to a
 * one-shot TCP server here.
 */

export const ROOT_AUDIO_REMOTE_JAR = '/data/local/tmp/ws-root-audio.jar';
export const ROOT_AUDIO_MAIN = 'com.wsphone.rootaudio.RootAudioMain';
export const ROOT_AUDIO_MIN_SDK = 21;

export const ROOT_AUDIO_HINT = '手机已 ROOT 的话：在 Magisk/KernelSU 的超级用户里允许「Shell」（com.android.shell），再重连即可听声音';
export const ROOT_AUDIO_FAILED = 'ROOT 采集手机声音失败（看服务日志 root-audio 行）；可在 Magisk 里确认「Shell」已授权后重连';

export interface RootAudioAdb {
    shell(serial: string, command: string, timeoutMs?: number): Promise<string>;
    push(serial: string, local: string, remote: string): Promise<void>;
    reverse(serial: string, remote: string, local: string): Promise<void>;
    removeReverse(serial: string, remote: string): Promise<void>;
    shellSpawn(serial: string, command: string): ChildProcess;
}

export function resolveRootAudioJar(exists: (file: string) => boolean = fs.existsSync): string | undefined {
    const candidates = [
        process.env['WS_ROOT_AUDIO_JAR'],
        path.join(__dirname, 'root-audio.jar'),
        path.resolve(__dirname, '../android/root-audio/prebuilt/root-audio.jar'),
        path.resolve(__dirname, '../../../android/root-audio/prebuilt/root-audio.jar'),
        path.resolve(process.cwd(), 'android/root-audio/prebuilt/root-audio.jar'),
    ];
    for (const candidate of candidates) {
        if (candidate && exists(candidate)) return candidate;
    }
    return undefined;
}

/** `su -c id` printed a root uid. */
export function isRootIdOutput(out: string): boolean {
    return /uid=0\(/.test(out) || /^uid=0\b/m.test(out);
}

const rootCache = new Map<string, { root: boolean; at: number }>();
const NEGATIVE_TTL_MS = 30_000;

/**
 * Whether `adb shell su` gives root on this phone. A yes is remembered for the
 * process lifetime; a no only briefly, so granting Shell in Magisk and
 * reconnecting picks it up without restarting the service.
 */
export async function hasRoot(adb: RootAudioAdb, serial: string, now = Date.now()): Promise<boolean> {
    const cached = rootCache.get(serial);
    if (cached && (cached.root || now - cached.at < NEGATIVE_TTL_MS)) return cached.root;
    let root = false;
    try {
        // Magisk shows its grant prompt for ~10 s the first time; wait for it.
        root = isRootIdOutput(await adb.shell(serial, 'su -c id 2>&1 </dev/null', 15_000));
    } catch {
        root = false;
    }
    rootCache.set(serial, { root, at: now });
    return root;
}

export function clearRootCache(): void {
    rootCache.clear();
}

export function rootAudioCommand(socketName: string, codec: 'aac' | 'raw'): string {
    return `su -c "CLASSPATH=${ROOT_AUDIO_REMOTE_JAR} app_process / ${ROOT_AUDIO_MAIN} ${socketName} ${codec}"`;
}

async function ensurePushed(adb: RootAudioAdb, serial: string, localJar: string): Promise<void> {
    const size = fs.statSync(localJar).size;
    try {
        const out = await adb.shell(serial, `wc -c < ${ROOT_AUDIO_REMOTE_JAR} 2>/dev/null`);
        if (Number.parseInt(out.trim(), 10) === size) return;
    } catch {
        // missing: push
    }
    await adb.push(serial, localJar, ROOT_AUDIO_REMOTE_JAR);
}

export interface RootAudioSession {
    /** Resolves with the helper's socket, or undefined if it never connected. */
    socket: Promise<net.Socket | undefined>;
    stop(): void;
}

export interface RootAudioLog {
    info(msg: string): void;
}

/**
 * Push the helper, open the reverse tunnel and start it under su. Never throws:
 * any failure resolves `socket` to undefined so the picture keeps going.
 */
export async function startRootAudio(
    adb: RootAudioAdb,
    serial: string,
    scid: string,
    codec: 'aac' | 'raw',
    localJar: string,
    log: RootAudioLog,
    connectTimeoutMs = 10_000,
): Promise<RootAudioSession> {
    const socketName = `wsaudio_${scid}`;
    const remote = `localabstract:${socketName}`;
    let server: net.Server | undefined;
    let proc: ChildProcess | undefined;
    let accepted: net.Socket | undefined;
    let reversed = false;
    let stopped = false;

    const stop = () => {
        if (stopped) return;
        stopped = true;
        accepted?.destroy();
        server?.close();
        if (proc && !proc.killed) proc.kill();
        if (reversed) adb.removeReverse(serial, remote).catch(() => undefined);
    };

    try {
        await ensurePushed(adb, serial, localJar);
        server = net.createServer();
        const port = await new Promise<number>((resolve, reject) => {
            server!.once('error', reject);
            server!.listen(0, '127.0.0.1', () => resolve((server!.address() as net.AddressInfo).port));
        });
        await adb.reverse(serial, remote, `tcp:${port}`);
        reversed = true;
    } catch (e) {
        log.info(`root-audio setup failed for ${serial}: ${(e as Error).message}`);
        stop();
        return { socket: Promise.resolve(undefined), stop };
    }

    const socket = new Promise<net.Socket | undefined>((resolve) => {
        const timer = setTimeout(() => {
            log.info(`root-audio helper did not connect for ${serial} within ${connectTimeoutMs}ms`);
            resolve(undefined);
        }, connectTimeoutMs);
        server!.once('connection', (sock) => {
            clearTimeout(timer);
            accepted = sock;
            sock.setNoDelay(true);
            server!.close();
            if (stopped) sock.destroy();
            resolve(sock);
        });
        proc = adb.shellSpawn(serial, rootAudioCommand(socketName, codec));
        const line = (data: Buffer) => {
            const text = data.toString('utf-8').trimEnd();
            if (text) log.info(`[root-audio] ${serial}: ${text}`);
        };
        proc.stdout?.on('data', line);
        proc.stderr?.on('data', line);
        proc.on('exit', (code) => {
            log.info(`root-audio helper exited for ${serial} (code=${code})`);
            if (!accepted) {
                clearTimeout(timer);
                resolve(undefined);
            }
        });
    });
    return { socket, stop };
}
