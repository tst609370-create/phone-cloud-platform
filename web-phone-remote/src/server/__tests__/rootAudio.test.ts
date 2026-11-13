import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRootCache, hasRoot, isRootIdOutput, type RootAudioAdb, rootAudioCommand, startRootAudio } from '../rootAudio';

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

    it('remembers a root yes, retries a no after a while', async () => {
        const shell = vi.fn().mockResolvedValueOnce('su: not found').mockResolvedValue('uid=0(root) gid=0(root)');
        const adb = { shell } as unknown as RootAudioAdb;
        expect(await hasRoot(adb, 'S', 1000)).toBe(false);
        expect(await hasRoot(adb, 'S', 2000)).toBe(false); // cached no
        expect(shell).toHaveBeenCalledTimes(1);
        expect(await hasRoot(adb, 'S', 40_000)).toBe(true);
        expect(await hasRoot(adb, 'S', 10_000_000)).toBe(true);
        expect(shell).toHaveBeenCalledTimes(2);
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
