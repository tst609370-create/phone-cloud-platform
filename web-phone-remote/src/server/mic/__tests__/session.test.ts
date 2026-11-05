import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import net from 'net';
import { describe, expect, it } from 'vitest';
import type { MicStatus } from '../../../common/micProtocol';
import { MicFrameDecoder, MicFrameType } from '../../../common/micProtocol';
import { type MicAdb, openLsposedMic, openShellMic, probeDeviceMic } from '../deviceBridge';
import { selectMicRoute } from '../route';
import { MicTalkSession } from '../session';

describe('MicTalkSession', () => {
    it('falls back from a failed LSPosed open to shell and then reports active', async () => {
        const statuses: MicStatus[] = [];
        const opened: string[] = [];
        const session = new MicTalkSession('PHONE1', {
            probe: async () => ({
                sdkInt: 34,
                rooted: true,
                bridgeInstalled: true,
                shellDexPresent: true,
                shellVerified: true,
            }),
            open: async (route) => {
                if (route === 'lsposed') throw new Error('adb reverse 失败');
                return {
                    route,
                    writePcm: async () => {
                        opened.push('pcm');
                    },
                    setActive: async (active) => {
                        opened.push(active ? 'on' : 'off');
                    },
                    close: async () => {
                        opened.push('close');
                    },
                };
            },
            onStatus: (status) => statuses.push(status),
        });
        await session.announce();
        expect(statuses[0]?.supported).toBe(true);
        expect(statuses[0]?.route).toBe('lsposed');
        await session.begin();
        expect(statuses.at(-1)?.route).toBe('shell');
        expect(statuses.at(-1)?.active).toBe(true);
        expect(statuses.at(-1)?.reason).toContain('lsposed 不可用');
        await session.write(Uint8Array.of(1, 0, 2, 0));
        expect(opened).toContain('pcm');
        await session.end();
        expect(opened).toContain('off');
        expect(statuses.at(-1)?.active).toBe(false);
        await session.close();
    });

    it('disables the route when nothing can be opened', async () => {
        const statuses: MicStatus[] = [];
        const session = new MicTalkSession('PHONE1', {
            probe: async () => ({
                sdkInt: 28,
                rooted: false,
                bridgeInstalled: false,
                shellDexPresent: false,
                shellVerified: 'unknown',
            }),
            open: async () => {
                throw new Error('should not open');
            },
            onStatus: (status) => statuses.push(status),
        });
        await session.announce();
        expect(statuses[0]?.supported).toBe(false);
        expect(statuses[0]?.reason).toContain('低于 13');
        await session.begin();
        expect(statuses.at(-1)?.active).toBe(false);
        await session.close();
    });
});

describe('device bridges', () => {
    it('pushes PCM to a shell injector that answered SHELL_MIC_READY', async () => {
        const received: Buffer[] = [];
        const server = net.createServer((socket) => {
            socket.on('data', (chunk) => received.push(Buffer.from(chunk)));
        });
        await listen(server);
        const port = (server.address() as net.AddressInfo).port;
        const removed: string[] = [];
        let spawned = 0;
        const adb = fakeAdb({
            port,
            spawned: () => {
                spawned += 1;
            },
            removed,
        });
        const mic = await openShellMic(adb, 'SERIAL', '/tmp/virtual-mic.jar');
        await mic.setActive(true);
        await mic.writePcm(Int16Array.of(7, -7));
        await waitFor(() => Buffer.concat(received).length > 20);
        const frames = new MicFrameDecoder().push(new Uint8Array(Buffer.concat(received)));
        expect(frames.map((frame) => frame.type)).toEqual([
            MicFrameType.HELLO,
            MicFrameType.FORMAT,
            MicFrameType.START,
            MicFrameType.PCM,
        ]);
        expect(new TextDecoder().decode(frames[0]?.payload)).toBe('INJECT');
        expect(spawned).toBe(1);
        await mic.close();
        expect(removed.length).toBe(1);
        await closeServer(server);
    });

    it('does not start the injector when the probe is refused', async () => {
        let spawned = 0;
        const adb = fakeAdb({
            port: 1,
            probe: 'SHELL_MIC_NO:registerAudioPolicy=-1',
            spawned: () => {
                spawned += 1;
            },
            removed: [],
        });
        await expect(openShellMic(adb, 'SERIAL', '/tmp/virtual-mic.jar')).rejects.toThrow(/registerAudioPolicy/);
        expect(spawned).toBe(0);
    });

    it('keeps shell unsupported when Android 14 refuses the live probe', async () => {
        const adb: MicAdb = {
            shell: async (_serial, command) => {
                if (command.startsWith('getprop')) return '34';
                if (command.startsWith('su ') || command === 'id' || command.startsWith('pm path')) {
                    throw new Error('not found');
                }
                return '';
            },
            push: async () => undefined,
            execOut: async () => Buffer.from('SHELL_MIC_NO:registerAudioPolicy=-1\n'),
            forward: async () => '',
            removeForward: async () => undefined,
            reverse: async () => undefined,
            removeReverse: async () => undefined,
            shellSpawn: () => {
                throw new Error('probe must not start the server');
            },
        };
        const facts = await probeDeviceMic(adb, 'SERIAL', '/tmp/virtual-mic.jar');
        expect(facts.sdkInt).toBe(34);
        expect(facts.shellVerified).toBe(false);
        expect(selectMicRoute(facts).supported).toBe(false);
        expect(selectMicRoute(facts).reason).toContain('不能只凭 Android 版本');
    });

    it('serves the LSPosed hook through the reversed host port', async () => {
        let reversed = '';
        const adb: MicAdb = {
            shell: async () => '',
            push: async () => undefined,
            execOut: async () => Buffer.from(''),
            forward: async () => '',
            removeForward: async () => undefined,
            reverse: async (_serial, remote, local) => {
                reversed = `${remote}->${local}`;
            },
            removeReverse: async () => undefined,
            shellSpawn: () => {
                throw new Error('shell spawn is not used for lsposed');
            },
        };
        const mic = await openLsposedMic(adb, 'SERIAL');
        expect(reversed.startsWith('tcp:28256->tcp:')).toBe(true);
        const port = Number(reversed.split(':').pop());
        const socket = await new Promise<net.Socket>((resolve, reject) => {
            const client = net.connect({ host: '127.0.0.1', port }, () => resolve(client));
            client.once('error', reject);
        });
        const decoder = new MicFrameDecoder();
        const got = new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no frame')), 2000);
            socket.on('data', (chunk) => {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                const frame = decoder.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))[0];
                if (!frame) return;
                clearTimeout(timer);
                resolve(frame.type);
            });
        });
        const { encodeMicRead } = await import('../../../common/micProtocol');
        socket.write(Buffer.from(encodeMicRead(48000, 1, 2, 4)));
        await expect(got).resolves.toBe(MicFrameType.INACTIVE);
        socket.destroy();
        await mic.close();
    });
});

function fakeAdb(opts: { port: number; spawned: () => void; removed: string[]; probe?: string }): MicAdb {
    return {
        shell: async () => '',
        push: async () => undefined,
        execOut: async () => Buffer.from(`${opts.probe ?? 'SHELL_MIC_OK'}\n`),
        forward: async () => String(opts.port),
        removeForward: async (_serial, local) => {
            opts.removed.push(local);
        },
        reverse: async () => undefined,
        removeReverse: async () => undefined,
        shellSpawn: () => {
            opts.spawned();
            const child = new EventEmitter() as ChildProcess;
            const stdout = new EventEmitter();
            const stderr = new EventEmitter();
            Object.assign(child, { stdout, stderr, kill: () => true });
            setTimeout(() => stdout.emit('data', Buffer.from('SHELL_MIC_READY\n')), 10);
            return child;
        },
    };
}

function listen(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
}

function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(ready: () => boolean): Promise<void> {
    const start = Date.now();
    while (!ready()) {
        if (Date.now() - start > 2000) throw new Error('timed out waiting for shell frames');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
