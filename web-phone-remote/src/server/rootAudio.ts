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

export const ROOT_AUDIO_FAILED = '已拿到 ROOT，但采集手机声音失败';

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

/** `id` printed a root uid. */
export function isRootIdOutput(out: string): boolean {
    return /uid=0\(/.test(out) || /^uid=0\b/m.test(out);
}

/**
 * How to run a command as root on this phone: '' when `adb shell` already is
 * root (many emulators: LDPlayer, Nox, MuMu with root on), otherwise a su
 * prefix that takes the command as one quoted argument.
 */
export type RootPrefix = string;

export interface RootProbe {
    prefix?: RootPrefix;
    /** Why there is no root, for the card under the picture. */
    reason?: string;
}

const SU_PATHS = ['/system/xbin/su', '/system/bin/su', '/sbin/su', '/su/bin/su', '/debug_ramdisk/su', '/system/sbin/su', '/vendor/bin/su'];

/** su spellings to try, best first. Different su builds take different syntax. */
export function suCandidates(found: string[]): RootPrefix[] {
    const out = ['su -c', 'su 0 sh -c', 'su root sh -c'];
    for (const p of found) out.push(`${p} -c`, `${p} 0 sh -c`);
    return [...new Set(out)];
}

export function wrapRoot(prefix: RootPrefix, command: string): string {
    return prefix ? `${prefix} "${command}"` : command;
}

export function noRootReason(foundSu: boolean, lastOutput: string): string {
    if (!foundSu) {
        return '这台没有 ROOT（找不到 su）。模拟器：在模拟器「设置 → 其他/高级」里打开 ROOT 权限并重启模拟器；真机要先刷 Magisk。然后重连即可听声音';
    }
    const detail = lastOutput.replace(/\s+/g, ' ').trim().slice(0, 120);
    return `有 su 但没给到 Shell 权限${detail ? `（${detail}）` : ''}。在 Magisk/KernelSU 超级用户里允许「Shell」，模拟器在弹出的授权框里点「允许/永久」，再重连即可听声音`;
}

const rootCache = new Map<string, { probe: RootProbe; at: number }>();
const NEGATIVE_TTL_MS = 30_000;

async function tryShell(adb: RootAudioAdb, serial: string, command: string, timeoutMs: number): Promise<string> {
    try {
        return await adb.shell(serial, command, timeoutMs);
    } catch (e) {
        return `${(e as Error).message || 'failed'}`;
    }
}

/**
 * Find a way to run as root. A yes is remembered for the process lifetime; a
 * no only briefly, so turning root on and reconnecting picks it up.
 */
export async function probeRoot(adb: RootAudioAdb, serial: string, now = Date.now(), log?: RootAudioLog): Promise<RootProbe> {
    const cached = rootCache.get(serial);
    if (cached && (cached.probe.prefix !== undefined || now - cached.at < NEGATIVE_TTL_MS)) return cached.probe;

    const remember = (probe: RootProbe) => {
        rootCache.set(serial, { probe, at: now });
        log?.info(`root probe for ${serial}: ${probe.prefix !== undefined ? `ok via "${probe.prefix || 'adb shell'}"` : probe.reason}`);
        return probe;
    };

    const scan = await tryShell(adb, serial, `id; for f in ${SU_PATHS.join(' ')}; do [ -e $f ] && echo SU=$f; done; command -v su | sed 's/^/SU=/'`, 8_000);
    if (isRootIdOutput(scan.split('\n')[0] ?? '')) return remember({ prefix: '' });
    const found = [...new Set([...scan.matchAll(/^SU=(\S+)/gm)].map((m) => m[1]!))];
    // `command -v` may be missing on old toolbox shells: still try plain su.
    let last = '';
    const tried: string[] = [];
    let suSeen = found.length > 0;
    for (const prefix of suCandidates(found)) {
        // Magisk shows its grant prompt for ~10 s the first time; wait for it once.
        const out = await tryShell(adb, serial, `${wrapRoot(prefix, 'id')} 2>&1 </dev/null`, prefix === 'su -c' ? 15_000 : 6_000);
        if (isRootIdOutput(out)) return remember({ prefix });
        if (!/not found|No such file|inaccessible/i.test(out)) suSeen = true;
        tried.push(prefix);
        last = out;
    }
    log?.info(`root probe for ${serial} tried: ${tried.join(' | ')}; scan: ${scan.replace(/\s+/g, ' ').slice(0, 200)}`);
    return remember({ reason: noRootReason(suSeen, `试了 ${tried.length} 种 su 写法，最后返回：${last}`) });
}

/** Back-compat yes/no wrapper. */
export async function hasRoot(adb: RootAudioAdb, serial: string, now = Date.now()): Promise<boolean> {
    return (await probeRoot(adb, serial, now)).prefix !== undefined;
}

export function clearRootCache(): void {
    rootCache.clear();
}

export function rootAudioCommand(socketName: string, codec: 'aac' | 'raw', prefix: RootPrefix = 'su -c'): string {
    return wrapRoot(prefix, `CLASSPATH=${ROOT_AUDIO_REMOTE_JAR} app_process / ${ROOT_AUDIO_MAIN} ${socketName} ${codec}`);
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
    /** The helper's own failure line (ROOT_AUDIO_NO:...), or the last thing it printed. */
    lastError(): string;
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
    prefix: RootPrefix = 'su -c',
): Promise<RootAudioSession> {
    const socketName = `wsaudio_${scid}`;
    const remote = `localabstract:${socketName}`;
    let server: net.Server | undefined;
    let proc: ChildProcess | undefined;
    let accepted: net.Socket | undefined;
    let reversed = false;
    let stopped = false;
    let lastError = '';
    let gotNo = false;

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
        const err = `准备失败：${(e as Error).message}`;
        return { socket: Promise.resolve(undefined), lastError: () => err, stop };
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
        proc = adb.shellSpawn(serial, rootAudioCommand(socketName, codec, prefix));
        const line = (data: Buffer) => {
            const text = data.toString('utf-8').trimEnd();
            if (!text) return;
            log.info(`[root-audio] ${serial}: ${text}`);
            const no = /ROOT_AUDIO_NO:(.*)/.exec(text);
            if (no) {
                lastError = no[1]!.trim();
                gotNo = true;
            } else if (!gotNo && !/ROOT_AUDIO_OK/.test(text)) {
                lastError = text.slice(-160);
            }
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
    return { socket, lastError: () => lastError, stop };
}
