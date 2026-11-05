import type { ChildProcess } from 'child_process';
import net from 'net';
import {
    ANDROID_SHELL_MIC_SDK,
    encodeMicFormat,
    encodeMicFrame,
    encodeMicText,
    MIC_DAEMON_PORT,
    MIC_PCM_RATE,
    MIC_REMOTE_JAR,
    MIC_SHELL_PORT,
    MicFrameType,
    type MicRouteName,
} from '../../common/micProtocol';
import { Logger } from '../Logger';
import { MicHub } from './hub';
import { s16leToBytes } from './resample';
import { type MicProbeFacts, parseForwardPort, parseShellProbe, probeMicFacts, shellMicCommand } from './route';

const log = Logger.for('MicBridge');

export interface OpenedMic {
    readonly route: MicRouteName;
    writePcm(samples: Int16Array): Promise<void>;
    setActive(active: boolean): Promise<void>;
    close(): Promise<void>;
}

export interface MicAdb {
    shell(serial: string, command: string, timeoutMs?: number): Promise<string>;
    push(serial: string, local: string, remote: string): Promise<void>;
    execOut(serial: string, command: string, timeoutMs?: number): Promise<Buffer>;
    forward(serial: string, local: string, remote: string): Promise<string>;
    removeForward(serial: string, local: string): Promise<void>;
    reverse(serial: string, remote: string, local: string): Promise<void>;
    removeReverse(serial: string, remote: string): Promise<void>;
    shellSpawn(serial: string, command: string): ChildProcess;
}

/**
 * Fast facts, then a real shell probe when that is the only possible route.
 * A high SDK is not treated as success: `shellVerified` stays false unless
 * the device prints SHELL_MIC_OK.
 */
export async function probeDeviceMic(adb: MicAdb, serial: string, jarPath: string | undefined): Promise<MicProbeFacts> {
    const facts = await probeMicFacts(adb, serial, jarPath !== undefined);
    if (facts.bridgeInstalled || !jarPath || facts.sdkInt < ANDROID_SHELL_MIC_SDK) {
        return { ...facts, shellVerified: false };
    }
    try {
        await adb.push(serial, jarPath, MIC_REMOTE_JAR);
        const out = await adb.execOut(serial, shellMicCommand('probe'), 20_000);
        return { ...facts, shellVerified: parseShellProbe(out.toString('utf8')).ok };
    } catch (err) {
        log.warn(`shell probe failed for ${serial}: ${messageOf(err)}`);
        return { ...facts, shellVerified: false };
    }
}

export async function openLsposedMic(adb: MicAdb, serial: string): Promise<OpenedMic> {
    const hub = new MicHub();
    let port = 0;
    try {
        port = await hub.listen();
        await adb.reverse(serial, `tcp:${MIC_DAEMON_PORT}`, `tcp:${port}`);
    } catch (err) {
        await hub.close();
        throw new Error(`无法建立虚拟麦克风反向通道：${messageOf(err)}`);
    }
    log.info(`lsposed hub for ${serial} on 127.0.0.1:${port} reversed to device:${MIC_DAEMON_PORT}`);
    return {
        route: 'lsposed',
        writePcm: async (samples) => {
            hub.writeMono48k(samples);
        },
        setActive: async (active) => {
            hub.setActive(active);
        },
        close: async () => {
            hub.setActive(false);
            await adb.removeReverse(serial, `tcp:${MIC_DAEMON_PORT}`).catch(() => undefined);
            await hub.close();
        },
    };
}

export async function openShellMic(adb: MicAdb, serial: string, jarPath: string): Promise<OpenedMic> {
    await adb.push(serial, jarPath, MIC_REMOTE_JAR);
    let probeText = '';
    try {
        const probe = await adb.execOut(serial, shellMicCommand('probe'), 20_000);
        probeText = probe.toString('utf8');
    } catch (err) {
        throw new Error(`shell 注入探测失败：${messageOf(err)}`);
    }
    const probed = parseShellProbe(probeText);
    if (!probed.ok) {
        throw new Error(probed.reason || '系统拒绝了 shell 麦克风注入');
    }
    // The pattern brackets keep pkill from matching its own command line.
    await adb.shell(serial, 'pkill -f com.wsphone.shellmic.ShellMic[M]ain || true', 3000).catch(() => undefined);
    const child = adb.shellSpawn(serial, shellMicCommand('serve'));
    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
        if (stderr.length > 20) stderr.shift();
    });
    let localPort = 0;
    try {
        const line = await waitForShellLine(child, 15_000);
        const ready = parseShellProbe(line);
        if (!ready.ready) {
            throw new Error(ready.reason || line || 'shell 注入进程没有就绪');
        }
        const forwarded = await adb.forward(serial, 'tcp:0', `tcp:${MIC_SHELL_PORT}`);
        localPort = parseForwardPort(forwarded);
        const socket = await connectLocal(localPort);
        writeFrame(socket, encodeMicText(MicFrameType.HELLO, 'INJECT'));
        writeFrame(socket, encodeMicFormat(MIC_PCM_RATE, 1, 16));
        let active = false;
        return {
            route: 'shell',
            writePcm: async (samples) => {
                if (!active || samples.length === 0) return;
                if (socket.destroyed) throw new Error('shell 注入连接已断开');
                writeFrame(socket, encodeMicFrame(MicFrameType.PCM, s16leToBytes(samples)));
            },
            setActive: async (on) => {
                active = on;
                writeFrame(socket, encodeMicFrame(on ? MicFrameType.START : MicFrameType.STOP, new Uint8Array(0)));
            },
            close: async () => {
                active = false;
                socket.destroy();
                killChild(child);
                if (localPort > 0) {
                    await adb.removeForward(serial, `tcp:${localPort}`).catch(() => undefined);
                }
                await adb
                    .shell(serial, 'pkill -f com.wsphone.shellmic.ShellMic[M]ain || true', 3000)
                    .catch(() => undefined);
            },
        };
    } catch (err) {
        killChild(child);
        if (localPort > 0) await adb.removeForward(serial, `tcp:${localPort}`).catch(() => undefined);
        const extra = Buffer.concat(stderr).toString('utf8').trim();
        throw new Error(extra ? `${messageOf(err)}（${extra.slice(0, 160)}）` : messageOf(err));
    }
}

export function waitForShellLine(child: ChildProcess, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        let buf = '';
        let settled = false;
        const timer = setTimeout(() => finish(() => reject(new Error('等待 shell 注入进程超时'))), timeoutMs);
        const onData = (chunk: Buffer | string) => {
            buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim().startsWith('SHELL_MIC_')) {
                    finish(() => resolve(line.trim()));
                    return;
                }
            }
        };
        const onExit = (code: number | null) => {
            finish(() => reject(new Error(`shell 注入进程退出 code=${code ?? '?'} ${buf.trim()}`)));
        };
        child.stdout?.on('data', onData);
        child.on('exit', onExit);
        child.on('error', (err) => finish(() => reject(err)));
        function finish(settle: () => void) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.stdout?.off('data', onData);
            child.off('exit', onExit);
            settle();
        }
    });
}

function connectLocal(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('连接手机注入端口超时'));
        }, 5000);
        socket.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        socket.once('connect', () => {
            clearTimeout(timer);
            socket.setTimeout(0);
            socket.setNoDelay(true);
            resolve(socket);
        });
    });
}

function writeFrame(socket: net.Socket, frame: Uint8Array): void {
    socket.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
}

function killChild(child: ChildProcess): void {
    try {
        child.kill('SIGKILL');
    } catch {
        // already gone
    }
}

function messageOf(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}
