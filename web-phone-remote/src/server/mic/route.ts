import fs from 'fs';
import path from 'path';
import { ANDROID_SHELL_MIC_SDK, MIC_REMOTE_JAR, type MicCapability, type MicRouteName } from '../../common/micProtocol';

export interface MicProbeFacts {
    sdkInt: number;
    rooted: boolean;
    bridgeInstalled: boolean;
    shellDexPresent: boolean;
    /** `false` only after AudioPolicy registration was refused. `unknown` means not tried yet. */
    shellVerified: boolean | 'unknown';
}

export interface MicRoutePlan {
    supported: boolean;
    routes: MicRouteName[];
    reason: string;
}

export interface MicShell {
    shell(serial: string, command: string, timeoutMs?: number): Promise<string>;
}

const SU_TIMEOUT_MS = 800;
const PROP_TIMEOUT_MS = 2000;

export function isRootId(output: string): boolean {
    return /(^|[\s;])uid=0(\(root\))?\b/.test(output);
}

export function isBridgeInstalled(pmPathOutput: string): boolean {
    return pmPathOutput.includes('package:') && pmPathOutput.includes('com.wsphone.virtualmic');
}

export function parseShellProbe(output: string): { ok: boolean; ready: boolean; reason: string } {
    const line = output
        .split(/\r?\n/)
        .map((part) => part.trim())
        .find((part) => part.startsWith('SHELL_MIC_'));
    if (!line) {
        const fallback = output.trim().replace(/\s+/g, ' ').slice(0, 180);
        return { ok: false, ready: false, reason: fallback || '注入组件没有输出' };
    }
    if (line.startsWith('SHELL_MIC_OK')) return { ok: true, ready: false, reason: '' };
    if (line.startsWith('SHELL_MIC_READY')) return { ok: true, ready: true, reason: '' };
    if (line.startsWith('SHELL_MIC_NO:')) {
        return { ok: false, ready: false, reason: line.slice('SHELL_MIC_NO:'.length).slice(0, 180) };
    }
    return { ok: false, ready: false, reason: line.slice(0, 180) };
}

export function parseForwardPort(output: string): number {
    const token = output.trim().split(/\s+/).pop() ?? '';
    const port = Number.parseInt(token, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('adb forward 未返回端口');
    }
    return port;
}

export function shellMicCommand(mode: 'probe' | 'serve'): string {
    return `CLASSPATH=${MIC_REMOTE_JAR} app_process / com.wsphone.shellmic.ShellMicMain ${mode}`;
}

export function selectMicRoute(facts: MicProbeFacts): MicRoutePlan {
    const routes: MicRouteName[] = [];
    // Shell injection stays experimental: Android 13+ only makes it worth probing.
    // The button may offer it only after this device's probe printed SHELL_MIC_OK.
    const shellCandidate =
        facts.shellVerified === true && facts.sdkInt >= ANDROID_SHELL_MIC_SDK && facts.shellDexPresent;
    if (facts.bridgeInstalled) routes.push('lsposed');
    if (shellCandidate) routes.push('shell');
    if (routes.length === 0) {
        return { supported: false, routes, reason: explainUnsupported(facts) };
    }
    if (routes[0] === 'lsposed') {
        return {
            supported: true,
            routes,
            reason: '已检测到 LSPosed 虚拟麦克风模块。按住按钮说话，单击可保持通话注入。',
        };
    }
    return {
        supported: true,
        routes,
        reason: '这台手机的 shell 注入探测已通过。请先按住电脑麦克风，再在微信里按住说话。',
    };
}

function explainUnsupported(facts: MicProbeFacts): string {
    const parts: string[] = [];
    parts.push(facts.rooted ? '已 root' : '未检测到 root');
    if (!facts.bridgeInstalled) parts.push('未安装虚拟麦克风模块');
    if (facts.sdkInt > 0 && facts.sdkInt < ANDROID_SHELL_MIC_SDK) {
        parts.push(`Android API ${facts.sdkInt} 低于 13`);
    } else if (facts.sdkInt <= 0) {
        parts.push('未能确认 Android 版本');
    } else if (!facts.shellDexPresent) {
        parts.push('服务端缺少 shell 注入组件');
    } else if (facts.shellVerified === false) {
        parts.push('shell 注入已探测但未通过');
    } else {
        parts.push('非 root 注入尚未在这台手机上探测通过');
    }
    return `${parts.join('，')}。不能只凭 Android 版本判定麦克风可用。需要已手动启用的 LSPosed 模块，或这台手机实际返回 SHELL_MIC_OK。`;
}

export function resolveVirtualMicJar(exists: (file: string) => boolean = fs.existsSync): string | undefined {
    const env = process.env['WS_VIRTUAL_MIC_JAR'];
    const candidates = [
        env,
        path.join(__dirname, 'virtual-mic.jar'),
        path.resolve(__dirname, '../android/virtual-mic/prebuilt/virtual-mic.jar'),
        path.resolve(__dirname, '../../../android/virtual-mic/prebuilt/virtual-mic.jar'),
        path.resolve(process.cwd(), 'android/virtual-mic/prebuilt/virtual-mic.jar'),
    ];
    for (const candidate of candidates) {
        if (candidate && exists(candidate)) return candidate;
    }
    return undefined;
}

export async function probeMicFacts(
    adb: MicShell,
    serial: string,
    shellDexPresent: boolean,
    cachedSdk = 0,
): Promise<MicProbeFacts> {
    const [sdkInt, rooted, bridgeInstalled] = await Promise.all([
        cachedSdk > 0 ? Promise.resolve(cachedSdk) : readSdk(adb, serial),
        detectRoot(adb, serial),
        detectBridge(adb, serial),
    ]);
    return {
        sdkInt,
        rooted,
        bridgeInstalled,
        shellDexPresent,
        shellVerified: 'unknown',
    };
}

export async function readMicCapability(adb: MicShell, serial: string, cachedSdk = 0): Promise<MicCapability> {
    try {
        const facts = await probeMicFacts(adb, serial, resolveVirtualMicJar() !== undefined, cachedSdk);
        const plan = selectMicRoute(facts);
        return {
            supported: plan.supported,
            routes: plan.routes,
            sdkInt: facts.sdkInt,
            rooted: facts.rooted,
            bridgeInstalled: facts.bridgeInstalled,
            reason: plan.reason,
        };
    } catch {
        return {
            supported: false,
            routes: [],
            sdkInt: cachedSdk,
            rooted: false,
            bridgeInstalled: false,
            reason: '麦克风能力探测失败',
        };
    }
}

async function readSdk(adb: MicShell, serial: string): Promise<number> {
    try {
        const output = await adb.shell(serial, 'getprop ro.build.version.sdk', PROP_TIMEOUT_MS);
        const sdk = Number.parseInt(output.trim(), 10);
        return Number.isFinite(sdk) ? sdk : 0;
    } catch {
        return 0;
    }
}

async function detectRoot(adb: MicShell, serial: string): Promise<boolean> {
    try {
        const su = await adb.shell(serial, 'su -c id', SU_TIMEOUT_MS);
        if (isRootId(su)) return true;
    } catch {
        // su missing, denied, or the Magisk prompt timed out
    }
    try {
        return isRootId(await adb.shell(serial, 'id', SU_TIMEOUT_MS));
    } catch {
        return false;
    }
}

async function detectBridge(adb: MicShell, serial: string): Promise<boolean> {
    try {
        return isBridgeInstalled(await adb.shell(serial, 'pm path com.wsphone.virtualmic', PROP_TIMEOUT_MS));
    } catch {
        return false;
    }
}
