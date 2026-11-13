import { mkdtempSync, writeFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
    denoiseExtras,
    ensureMicApp,
    getDenoise,
    installedVersion,
    type MicAppAdb,
    micPermissionState,
    parseErrorReason,
    setDenoise,
    startMicApp,
} from '../micApp';

const GRANTED = 'android.permission.RECORD_AUDIO: granted=true\n__OPS\nRECORD_AUDIO: allow; time=+1s';

function apk(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mic-apk-'));
    const file = path.join(dir, 'mic-audio.apk');
    writeFileSync(file, Buffer.alloc(10));
    return file;
}

const quiet = { info: () => undefined };

describe('no-root mic app', () => {
    it('reads the installed version', () => {
        expect(installedVersion('    versionCode=1 minSdk=23 targetSdk=28')).toBe(1);
        expect(installedVersion('')).toBe(0);
    });

    it('installs when missing and grants record + MIUI switches', async () => {
        const shell = vi.fn(async (_s: string, cmd: string) =>
            cmd.startsWith('getprop ro.miui') ? 'V12' : cmd.includes('__OPS') ? GRANTED : '',
        );
        const install = vi.fn(async () => 'Performing Streamed Install\nSuccess');
        const adb = { shell, install } as unknown as MicAppAdb;
        expect(await ensureMicApp(adb, 'M', apk())).toBe('');
        expect(install).toHaveBeenCalled();
        const grants = shell.mock.calls.map((c) => String(c[1])).find((c) => c.includes('pm grant'))!;
        expect(grants).toContain('pm grant com.wsphone.micaudio android.permission.RECORD_AUDIO');
        expect(grants).toContain('appops set com.wsphone.micaudio 10021 allow');
    });

    it('explains MIUI USB-install blocks', async () => {
        const shell = vi.fn(async () => '');
        const install = vi.fn(async () => {
            throw Object.assign(new Error('adb exit (path=C:\\adb.exe)'), {
                cause: { stdout: 'Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]' },
            });
        });
        const why = await ensureMicApp({ shell, install } as unknown as MicAppAdb, 'M', apk());
        expect(why).toContain('USB 安装');
        expect(why).not.toContain('path=');
    });

    it('reports a record permission MIUI silently refused', async () => {
        const shell = vi.fn(async (_s: string, cmd: string) =>
            cmd.includes('versionCode')
                ? 'versionCode=5'
                : cmd.includes('__OPS')
                  ? 'android.permission.RECORD_AUDIO: granted=false\n__OPS\nRECORD_AUDIO: ignore'
                  : '',
        );
        const why = await ensureMicApp({ shell, install: vi.fn() } as unknown as MicAppAdb, 'M', apk());
        expect(why).toContain('没授予');
        expect(why).toContain('ignore');
        expect(micPermissionState(GRANTED)).toEqual({ granted: true, op: 'allow' });
    });

    it('turns noise reduction on by default and changes it live', async () => {
        expect(getDenoise('D')).toBe('normal');
        expect(denoiseExtras('normal')).toBe('--es denoise 1 --es gate -48 --es hp 100 --es lp 8000');
        expect(denoiseExtras('off')).toBe('--es denoise 0 --es gate 0 --es hp 100 --es lp 8000');
        const shell = vi.fn(async () => '');
        await setDenoise({ shell } as unknown as MicAppAdb, 'D', 'strong');
        expect(getDenoise('D')).toBe('strong');
        expect(shell).toHaveBeenCalledWith(
            'D',
            expect.stringContaining('-a config --es denoise 1 --es gate -40 --es hp 150 --es lp 4500'),
            10_000,
        );
    });

    it('parses the error reason the app sends', () => {
        const msg = Buffer.from('IllegalStateException: mic busy', 'utf-8');
        const buf = Buffer.alloc(8 + msg.length);
        buf.writeUInt32BE(1, 0);
        buf.writeUInt32BE(msg.length, 4);
        msg.copy(buf, 8);
        expect(parseErrorReason(buf)).toBe('IllegalStateException: mic busy');
        expect(parseErrorReason(Buffer.from([0, 0x61, 0x61, 0x63]))).toBeUndefined();
    });

    it('starts the service, forwards and hands over the stream from its first byte', async () => {
        // Fake "phone": a TCP server standing in for the forwarded abstract socket.
        let phonePort = 0;
        const phone = net.createServer((c) => c.write(Buffer.from([0, 0x61, 0x61, 0x63, 9, 9])));
        await new Promise<void>((r) => phone.listen(0, '127.0.0.1', () => r()));
        phonePort = (phone.address() as net.AddressInfo).port;
        const relays: net.Server[] = [];
        const adb: MicAppAdb = {
            shell: vi.fn(async (_s: string, cmd: string) =>
                cmd.includes('versionCode')
                    ? 'versionCode=5'
                    : cmd.includes('__OPS')
                      ? GRANTED
                      : 'Starting service: Intent { }',
            ),
            install: vi.fn(),
            forward: vi.fn(async (_s: string, local: string) => {
                // Relay local port → fake phone, like adb forward does.
                const relay = net.createServer((c) => {
                    const up = net.createConnection({ host: '127.0.0.1', port: phonePort });
                    c.pipe(up);
                    up.pipe(c);
                });
                relays.push(relay);
                await new Promise<void>((r) => relay.listen(Number(local.slice(4)), '127.0.0.1', () => r()));
                return '';
            }),
            removeForward: vi.fn(async () => undefined),
        };
        const session = await startMicApp(adb, 'M', 'abc', 'aac', apk(), quiet, 5_000);
        expect(adb.install).not.toHaveBeenCalled();
        expect(adb.shell).toHaveBeenCalledWith(
            'M',
            expect.stringContaining(
                'am start-foreground-service -n com.wsphone.micaudio/.MicService --es socket wsmic_abc --es codec aac',
            ),
            10_000,
        );
        const sock = await session.socket;
        expect(sock).toBeDefined();
        const got = await new Promise<Buffer>((resolve) => {
            let all = Buffer.alloc(0);
            sock!.on('data', (c: Buffer) => {
                all = Buffer.concat([all, c]);
                if (all.length >= 6) resolve(all);
            });
        });
        expect([...got.subarray(0, 6)]).toEqual([0, 0x61, 0x61, 0x63, 9, 9]);
        session.stop();
        expect(adb.removeForward).toHaveBeenCalled();
        // The phone app is told to stop that session, releasing the microphone.
        expect(adb.shell).toHaveBeenCalledWith('M', expect.stringContaining('-a stop --es socket wsmic_abc'), 10_000);
        for (const r of relays) r.close();
        phone.close();
    });
});
