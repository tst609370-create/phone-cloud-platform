import type { ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { type GrantReport, MAGISK_SHELL_FOREVER, autoGrantWhile, prepareMagiskPrompt } from './rootGrant';

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

/** No root: the phone plays out loud and its microphone records it (adb shell may record on Android 9/10). */
export const MIC_FALLBACK_FAILED = '这台没 ROOT，改用录音小程序录手机外放也失败了';
export const ROOT_AUDIO_FAILED = '已拿到 ROOT，但采集手机声音失败';

export interface RootAudioAdb {
    shell(serial: string, command: string, timeoutMs?: number): Promise<string>;
    push(serial: string, local: string, remote: string): Promise<void>;
    reverse(serial: string, remote: string, local: string): Promise<void>;
    removeReverse(serial: string, remote: string): Promise<void>;
    shellSpawn(serial: string, command: string): ChildProcess;
    /** `adb root` (restart adbd as root; only works on debuggable builds). */
    root?(serial: string): Promise<string>;
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

// BlueStacks keeps its su at /system/xbin/bstk/su (root switch in Settings → Advanced).
const SU_PATHS = [
    '/system/xbin/su',
    '/system/bin/su',
    '/sbin/su',
    '/su/bin/su',
    '/debug_ramdisk/su',
    '/system/sbin/su',
    '/vendor/bin/su',
    '/system/xbin/bstk/su',
    '/system/xbin/*/su',
    '/system/bin/*/su',
];

/**
 * su spellings to try, best first. Different su builds take different syntax;
 * some (BlueStacks' bstk su) ignore -c and only read commands from stdin, so
 * the "{} |" forms pipe the command in.
 */
export function suCandidates(found: string[]): RootPrefix[] {
    const out = ['su -c', 'su 0 sh -c', 'su root sh -c'];
    for (const p of found) out.push(`${p} -c`, `${p} 0 sh -c`, `${p} root sh -c`);
    out.push('| su');
    for (const p of found) out.push(`| ${p}`);
    return [...new Set(out)];
}

/** Prefix "su -c" → su -c "cmd"; prefix "| su" → echo "cmd" | su; '' → cmd. */
export function wrapRoot(prefix: RootPrefix, command: string): string {
    if (!prefix) return command;
    if (prefix.startsWith('| ')) return `echo "${command}" | ${prefix.slice(2)}`;
    return `${prefix} "${command}"`;
}

export type RootKind = 'magisk' | 'supersu' | 'kernelsu' | 'system' | 'unknown';

/** Which root solution `su -v` (and friends) point at. */
export function rootKindOf(suVersion: string, pkgs: string): RootKind {
    const v = `${suVersion}\n${pkgs}`;
    if (/kernelsu/i.test(v)) return 'kernelsu';
    if (/magisk/i.test(v)) return 'magisk';
    if (/supersu|chainfire|eu\.chainfire/i.test(v)) return 'supersu';
    if (/superuser|koush|phh|miui|xiaomi/i.test(v) || /^\s*\d+(\.\d+)*\s*$/m.test(suVersion)) return 'system';
    return 'unknown';
}

export const ROOT_KIND_LABEL: Record<RootKind, string> = {
    magisk: 'Magisk',
    supersu: 'SuperSU',
    kernelsu: 'KernelSU',
    system: '系统自带/其它 su',
    unknown: '未识别的 su',
};

/** One precise manual step per root solution. */
export function rootKindHint(kind: RootKind): string {
    switch (kind) {
        case 'magisk':
            return 'Magisk 的授权框会自动点允许；没弹框时检查：Magisk「设置 → 超级用户访问权限」要选「应用和 ADB」、「自动响应」别选拒绝，小米手机在「应用设置 → Magisk → 其他权限」打开「后台弹出界面」，手机要亮屏解锁';
        case 'supersu':
            return 'SuperSU：打开 SuperSU → 设置 →「默认访问」选「授权」（或在「应用」列表里把 ADB shell 设为授权）';
        case 'kernelsu':
            return 'KernelSU：打开 KernelSU 管理器 →「超级用户」→ 找到 Shell（com.android.shell）打开开关';
        case 'system':
            return '像是系统自带 ROOT（如 MIUI 开发版）：在「安全中心/手机管家 → 应用管理 → 权限 → ROOT 权限管理」里给「Shell」或「com.android.shell」开启；没有该项就先在那里开启 ROOT 权限并重启手机';
        default:
            return '在手机的 ROOT 管理应用（Magisk/SuperSU/KernelSU 或安全中心「ROOT 权限管理」）里给 Shell（com.android.shell）授权';
    }
}

export function noRootReason(foundSu: boolean, lastOutput: string, kind?: RootKind): string {
    if (!foundSu) {
        const d = lastOutput.replace(/\s+/g, ' ').trim().slice(0, 200);
        return `这台手机其实没有 ROOT：adb 里找不到 su${d ? `（${d}）` : ''}。真机：打开 Magisk 看首页「Magisk」一栏是否显示已安装的版本号，显示「无」就是没 ROOT 成功或系统更新后失效，需要重新刷入；模拟器：在设置里打开 ROOT 权限并重启模拟器。然后重连即可听声音`;
    }
    const detail = lastOutput.replace(/\s+/g, ' ').trim().slice(0, 420);
    const k = kind ?? 'unknown';
    return `有 su 但没给到 Shell 权限（ROOT 类型：${ROOT_KIND_LABEL[k]}${detail ? `；${detail}` : ''}）。${rootKindHint(k)}。模拟器在弹框里点「允许/永久」。改好后重连即可听声音`;
}

const rootCache = new Map<string, { probe: RootProbe; at: number }>();
const NEGATIVE_TTL_MS = 45_000;
// The picture waits for this probe, so keep a hard budget on it.
const PROBE_BUDGET_MS = 20_000;

/**
 * Run a probe and always get its output back. `adb shell` passes the remote
 * exit code through and AdbClient throws on non-zero, which used to drop the
 * output ("su: not found", "Permission denied") on the floor. Appending an
 * echo makes the shell exit 0 and carries the real code in the text instead.
 */
async function tryShell(adb: RootAudioAdb, serial: string, command: string, timeoutMs: number): Promise<string> {
    try {
        const out = await adb.shell(serial, `${command}; echo __RC=$?`, timeoutMs);
        const m = /__RC=(\d+)\s*$/.exec(out);
        if (!m) return out;
        const body = out.slice(0, m.index).trimEnd();
        return m[1] === '0' ? body : `${body}${body ? ' ' : ''}[退出码 ${m[1]}]`;
    } catch (e) {
        return adbErrorText(e);
    }
}

/** Short, path-free description of an adb failure. */
export function adbErrorText(e: unknown): string {
    const err = e as { kind?: string; cause?: unknown; message?: string };
    const cause = err.cause as { stdout?: string; stderr?: string; code?: unknown; message?: string } | undefined;
    const parts = [err.kind === 'timeout' ? 'adb 超时' : `adb ${err.kind ?? '出错'}`];
    if (cause && typeof cause.code === 'number') parts.push(`退出码 ${cause.code}`);
    const text = `${cause?.stdout ?? ''} ${cause?.stderr ?? ''}`.replace(/\s+/g, ' ').trim();
    if (text) parts.push(text.slice(0, 200));
    else if (!err.kind && err.message) parts.push(err.message.replace(/\(path=[^)]*\)/, '').slice(0, 200));
    return parts.join('：');
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
    const prep = found.length > 0 ? await prepareMagiskPrompt(adb, serial) : '';
    // su -v is answered without asking for permission (Magisk/SuperSU/KernelSU print their name).
    const info = await tryShell(adb, serial, 'su -v 2>&1 </dev/null | head -1; echo PROPS; getprop ro.debuggable; getprop ro.build.type; echo PKGS; pm list packages 2>/dev/null | grep -i -E "magisk|kernelsu|supersu|superuser|chainfire"', 8_000);
    const [suVersion = '', propsAndPkgs = ''] = info.split('PROPS');
    const [props = '', pkgs = ''] = propsAndPkgs.split('PKGS');
    const [debuggable = '', buildType = ''] = props.trim().split(/\s+/);
    const kind = rootKindOf(suVersion.trim(), pkgs);
    let grantNote = '';
    const deadline = Date.now() + PROBE_BUDGET_MS;
    for (const prefix of suCandidates(found)) {
        const left = deadline - Date.now();
        if (left < 1_000) {
            tried.push('（超时，没试完）');
            break;
        }
        // Magisk shows its grant prompt for ~10 s the first time; wait for it once.
        const viaStdin = prefix.startsWith('| ');
        const cmd = viaStdin ? `${wrapRoot(prefix, 'id')} 2>&1` : `${wrapRoot(prefix, 'id')} 2>&1 </dev/null`;
        const attempt = tryShell(adb, serial, cmd, Math.min(left, prefix === 'su -c' ? 12_000 : 4_000));
        // First real su call may raise Magisk's prompt: tap "允许" for the user.
        const watching = prefix === 'su -c' && found.length > 0;
        const grant: Promise<GrantReport | undefined> = watching ? autoGrantWhile(adb, serial, attempt, Math.min(left, 11_000)) : Promise.resolve(undefined);
        let out = await attempt;
        const report = await grant;
        if (report) {
            grantNote = report.note;
            log?.info(`superuser prompt on ${serial}: ${report.note}`);
            // Tapped "允许" after su already gave up: ask once more, Magisk now remembers it.
            if (report.tapped && !isRootIdOutput(out)) out = await tryShell(adb, serial, cmd, 6_000);
        }
        if (isRootIdOutput(out)) {
            // Make the grant permanent so the prompt never comes back (Magisk only; harmless elsewhere).
            await tryShell(adb, serial, `${wrapRoot(prefix, MAGISK_SHELL_FOREVER)} 2>&1${viaStdin ? '' : ' </dev/null'}`, 5_000);
            return remember({ prefix });
        }
        if (!/not found|No such file|inaccessible|退出码 127/i.test(out)) suSeen = true;
        tried.push(`${prefix} → ${out.replace(/\s+/g, ' ').trim().slice(0, 50) || '(空，可能超时)'}`);
        last = out;
    }
    log?.info(`root probe for ${serial} tried: ${tried.join(' | ')}; scan: ${scan.replace(/\s+/g, ' ').slice(0, 200)}`);
    void last;
    // Debuggable builds (MIUI 开发版 with root on, userdebug ROMs) can run adbd itself as root.
    let adbRootNote = '';
    if (debuggable === '1' && adb.root) {
        const res = await adb.root(serial).catch((e: Error) => e.message);
        await new Promise((r) => setTimeout(r, 3_000));
        const id = await tryShell(adb, serial, 'id', 8_000);
        if (isRootIdOutput(id)) return remember({ prefix: '' });
        adbRootNote = `adb root：${String(res).replace(/\s+/g, ' ').trim().slice(0, 60)}`;
    }
    const detail = [
        `su 在 ${found.join(',') || '?'}，su -v：${suVersion.trim().slice(0, 30) || '(无)'}，debuggable=${debuggable || '?'} ${buildType}`,
        adbRootNote,
        prep,
        grantNote && `授权框：${grantNote}`,
        `试了：${tried.slice(0, 4).join('；')}${tried.length > 4 ? ` 等 ${tried.length} 种` : ''}`,
    ]
        .filter(Boolean)
        .join('。');
    return remember({ reason: noRootReason(suSeen, suSeen ? detail : (tried[0] ?? ''), kind) });
}

/** Back-compat yes/no wrapper. */
export async function hasRoot(adb: RootAudioAdb, serial: string, now = Date.now()): Promise<boolean> {
    return (await probeRoot(adb, serial, now)).prefix !== undefined;
}

export function clearRootCache(): void {
    rootCache.clear();
}

export type CaptureSource = 'submix' | 'mic';

export function rootAudioCommand(socketName: string, codec: 'aac' | 'raw', prefix: RootPrefix = 'su -c', source: CaptureSource = 'submix'): string {
    const tail = source === 'mic' ? ' mic' : '';
    return wrapRoot(prefix, `CLASSPATH=${ROOT_AUDIO_REMOTE_JAR} app_process / ${ROOT_AUDIO_MAIN} ${socketName} ${codec}${tail}`);
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
    source: CaptureSource = 'submix',
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
        proc = adb.shellSpawn(serial, rootAudioCommand(socketName, codec, prefix, source));
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
