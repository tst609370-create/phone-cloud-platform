import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRootCache, hasRoot, isRootIdOutput, probeRoot, rootKindOf, type RootAudioAdb, rootAudioCommand, startRootAudio, wrapRoot } from '../rootAudio';

function fakeProc() {
    const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; killed: boolean; kill: () => void };
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = () => {
        proc.killed = true;
    };
    return proc;
}

function jar(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'root-audio-'));
    const file = path.join(dir, 'root-audio.jar');
    writeFileSync(file, Buffer.alloc(123));
    return file;
}

describe('root audio helper', () => {
    beforeEach(() => clearRootCache());

    it('recognises su id output', () => {
        expect(isRootIdOutput('uid=0(root) gid=0(root) groups=0(root) context=u:r:magisk:s0')).toBe(true);
        expect(isRootIdOutput('/system/bin/sh: su: inaccessible or not found')).toBe(false);
        expect(isRootIdOutput('Permission denied')).toBe(false);
        expect(isRootIdOutput('uid=2000(shell) gid=2000(shell)')).toBe(false);
    });

    it('runs the helper under su with the socket name and codec', () => {
        expect(rootAudioCommand('wsaudio_1a2b', 'aac')).toBe(
            'su -c "CLASSPATH=/data/local/tmp/ws-root-audio.jar app_process / com.wsphone.rootaudio.RootAudioMain wsaudio_1a2b aac"',
        );
    });

    it('uses adb shell directly when it already is root (emulators)', async () => {
        const shell = vi.fn().mockResolvedValue('uid=0(root) gid=0(root)\nSU=/system/xbin/su\n');
        const probe = await probeRoot({ shell } as unknown as RootAudioAdb, 'E', 1);
        expect(probe.prefix).toBe('');
        expect(shell).toHaveBeenCalledTimes(1);
        expect(rootAudioCommand('n', 'raw', '')).toBe('CLASSPATH=/data/local/tmp/ws-root-audio.jar app_process / com.wsphone.rootaudio.RootAudioMain n raw');
    });

    it('says there is no su so the user turns root on', async () => {
        const shell = vi.fn(async (_s: string, cmd: string) =>
            cmd.startsWith('id;') ? 'uid=2000(shell) gid=2000(shell)\n' : '/system/bin/sh: su: not found',
        );
        const probe = await probeRoot({ shell } as unknown as RootAudioAdb, 'E', 1);
        expect(probe.prefix).toBeUndefined();
        expect(probe.reason).toContain('找不到 su');
    });

    it('tries other su spellings when su -c is refused', async () => {
        const shell = vi.fn(async (_s: string, cmd: string) => {
            if (cmd.startsWith('id;')) return 'uid=2000(shell)\nSU=/system/xbin/su\n';
            if (cmd.startsWith('su 0 sh -c')) return 'uid=0(root) gid=0(root)';
            return 'su: invalid option -- c';
        });
        const probe = await probeRoot({ shell } as unknown as RootAudioAdb, 'E', 1);
        expect(probe.prefix).toBe('su 0 sh -c');
        expect(wrapRoot('su 0 sh -c', 'id')).toBe('su 0 sh -c "id"');
    });

    it('finds BlueStacks su that only reads commands from stdin', async () => {
        const shell = vi.fn(async (_s: string, cmd: string) => {
            if (cmd.startsWith('id;')) return 'uid=2000(shell) gid=2000(shell)\nSU=/system/xbin/bstk/su\n';
            if (cmd.startsWith('echo "id" | /system/xbin/bstk/su')) return 'uid=0(root) gid=0(root)';
            if (cmd.includes('/system/xbin/bstk/su')) return 'usage: su';
            return '/system/bin/sh: su: not found';
        });
        const probe = await probeRoot({ shell } as unknown as RootAudioAdb, 'B', 1);
        expect(probe.prefix).toBe('| /system/xbin/bstk/su');
        expect(rootAudioCommand('n', 'aac', probe.prefix)).toBe(
            'echo "CLASSPATH=/data/local/tmp/ws-root-audio.jar app_process / com.wsphone.rootaudio.RootAudioMain n aac" | /system/xbin/bstk/su',
        );
    });

    it('names the root solution from su -v', () => {
        expect(rootKindOf('26.4:MAGISK:R', '')).toBe('magisk');
        expect(rootKindOf('2.82:SUPERSU', '')).toBe('supersu');
        expect(rootKindOf('', 'package:me.weishu.kernelsu')).toBe('kernelsu');
        expect(rootKindOf('16', '')).toBe('system');
        expect(rootKindOf('su: invalid option', '')).toBe('unknown');
    });

    it('falls back to adb root on debuggable builds and says what it found', async () => {
        let rooted = false;
        const shell = vi.fn(async (_s: string, cmd: string) => {
            if (cmd === 'id') return rooted ? 'uid=0(root)' : 'uid=2000(shell)';
            if (cmd.startsWith('id;')) return 'uid=2000(shell)\nSU=/system/xbin/su\n';
            if (cmd.startsWith('su -v')) return '16\nPROPS\n1\nuser\nPKGS\n';
            return 'Permission denied';
        });
        const root = vi.fn(async () => {
            rooted = true;
            return 'restarting adbd as root';
        });
        const probe = await probeRoot({ shell, root } as unknown as RootAudioAdb, 'MI', 1);
        expect(root).toHaveBeenCalledWith('MI');
        expect(probe.prefix).toBe('');
    }, 30_000);

    it('tells MIUI built-in root users where to grant Shell', async () => {
        const shell = vi.fn(async (_s: string, cmd: string) => {
            if (cmd.startsWith('id;')) return 'uid=2000(shell)\nSU=/system/xbin/su\n';
            if (cmd.startsWith('su -v')) return '16\nPROPS\n0\nuser\nPKGS\n';
            return 'Permission denied';
        });
        const probe = await probeRoot({ shell } as unknown as RootAudioAdb, 'MI2', 1);
        expect(probe.reason).toContain('系统自带');
        expect(probe.reason).toContain('ROOT 权限管理');
    }, 30_000);

    it('remembers a root yes, retries a no after a while', async () => {
        const shell = vi
            .fn()
            .mockResolvedValueOnce('uid=2000(shell)\nSU=/sbin/su')
            .mockResolvedValue('Permission denied');
        const adb = { shell } as unknown as RootAudioAdb;
        const no = await probeRoot(adb, 'S', 1000);
        expect(no.reason).toContain('Permission denied');
        const calls = shell.mock.calls.length;
        expect(await hasRoot(adb, 'S', 2000)).toBe(false); // cached no
        expect(shell).toHaveBeenCalledTimes(calls);
        shell.mockReset();
        shell.mockResolvedValueOnce('uid=2000(shell)\nSU=/sbin/su').mockResolvedValue('uid=0(root)');
        expect(await hasRoot(adb, 'S', 200_000)).toBe(true);
        expect(shell).toHaveBeenCalledWith('S', expect.stringContaining('magisk --sqlite'), 5_000); // made permanent
        const after = shell.mock.calls.length;
        expect(await hasRoot(adb, 'S', 10_000_000)).toBe(true);
        expect(shell).toHaveBeenCalledTimes(after);
    });

    it('hands over the socket the helper connects with, and cleans up', async () => {
        let port = 0;
        const proc = fakeProc();
        const adb: RootAudioAdb = {
            shell: vi.fn().mockResolvedValue('0'),
            push: vi.fn().mockResolvedValue(undefined),
            reverse: vi.fn(async (_s: string, _remote: string, local: string) => {
                port = Number(local.replace('tcp:', ''));
            }),
            removeReverse: vi.fn().mockResolvedValue(undefined),
            shellSpawn: vi.fn(() => {
                // The phone side: connect back through the "reverse tunnel" and send the codec id.
                setTimeout(() => {
                    const c = net.createConnection({ host: '127.0.0.1', port }, () => c.write(Buffer.from([0, 0x61, 0x61, 0x63])));
                }, 10);
                return proc as never;
            }),
        };
        const session = await startRootAudio(adb, 'S', 'abc', 'aac', jar(), { info: () => undefined }, 2000);
        expect(adb.push).toHaveBeenCalledWith('S', expect.stringContaining('root-audio.jar'), '/data/local/tmp/ws-root-audio.jar');
        expect(adb.reverse).toHaveBeenCalledWith('S', 'localabstract:wsaudio_abc', expect.stringMatching(/^tcp:\d+$/));
        const sock = await session.socket;
        expect(sock).toBeDefined();
        const id = await new Promise<Buffer>((resolve) => sock!.once('data', resolve));
        expect(id.readUInt32BE(0)).toBe(0x00616163);
        session.stop();
        expect(proc.killed).toBe(true);
        expect(adb.removeReverse).toHaveBeenCalledWith('S', 'localabstract:wsaudio_abc');
    });

    it('gives up quietly when the helper exits without connecting', async () => {
        const proc = fakeProc();
        const adb: RootAudioAdb = {
            shell: vi.fn().mockResolvedValue('123'),
            push: vi.fn(),
            reverse: vi.fn().mockResolvedValue(undefined),
            removeReverse: vi.fn().mockResolvedValue(undefined),
            shellSpawn: vi.fn(() => {
                setTimeout(() => proc.emit('exit', 1), 10);
                return proc as never;
            }),
        };
        const session = await startRootAudio(adb, 'S', 'x', 'raw', jar(), { info: () => undefined }, 2000);
        expect(adb.push).not.toHaveBeenCalled(); // same size already on the phone
        expect(await session.socket).toBeUndefined();
        session.stop();
    });
});
