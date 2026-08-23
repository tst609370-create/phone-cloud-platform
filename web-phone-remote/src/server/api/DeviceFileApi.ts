import { createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { AdbClient } from '../AdbClient';
import { requireDeviceAccess } from '../auth/deviceAccess';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { assertSerial, shArg } from '../security/deviceInput';
import { sendInternalError } from './utils';

const log = Logger.for('DeviceFileApi');
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']);

export function safeUploadName(value: string): string {
    const base = path
        .basename(value)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: file names must strip ASCII control bytes.
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
        .trim();
    if (!base || base === '.' || base === '..') throw new Error('invalid file name');
    return base.slice(0, 180);
}

export async function saveUploadRequest(req: IncomingMessage, target: string): Promise<void> {
    let size = 0;
    const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) callback(new Error('upload too large'));
            else callback(null, chunk);
        },
    });
    await pipeline(req, limiter, createWriteStream(target, { flags: 'wx' }));
}

export class DeviceFileApi {
    private readonly adbClient = new AdbClient(Config.getInstance().adbPath);

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const requestUrl = new URL(req.url || '/', 'http://localhost');
        if (req.method !== 'POST' || requestUrl.pathname !== '/api/devices/file') return false;
        res.setHeader('Content-Type', 'application/json');

        let tempDir = '';
        try {
            const serial = assertSerial(requestUrl.searchParams.get('serial'));
            if (!requireDeviceAccess(req, res, serial)) return true;
            const name = safeUploadName(requestUrl.searchParams.get('name') || '');
            const extension = path.extname(name).toLowerCase();
            if (extension !== '.apk' && !IMAGE_EXTENSIONS.has(extension)) {
                res.writeHead(415);
                res.end(JSON.stringify({ error: 'only image and APK files are supported' }));
                return true;
            }
            const connected = await this.adbClient.devices();
            if (!connected.some((device) => device.serial === serial && device.state === 'device')) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'device is not connected' }));
                return true;
            }

            tempDir = await mkdtemp(path.join(os.tmpdir(), 'phone-upload-'));
            const localFile = path.join(tempDir, extension === '.apk' ? 'upload.apk' : `upload${extension}`);
            await saveUploadRequest(req, localFile);

            if (extension === '.apk') {
                await this.adbClient.install(serial, localFile);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, action: 'installed' }));
                return true;
            }

            const remoteDir = '/sdcard/Pictures/RemoteUpload';
            const remoteFile = `${remoteDir}/${Date.now()}_${name}`;
            await this.adbClient.shell(serial, `mkdir -p ${shArg(remoteDir)}`);
            await this.adbClient.push(serial, localFile, remoteFile);
            await this.adbClient.shell(
                serial,
                `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shArg(`file://${remoteFile}`)}`,
            );
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, action: 'saved', path: remoteFile }));
            return true;
        } catch (error) {
            log.error('device file operation failed', error);
            sendInternalError(res);
            return true;
        } finally {
            if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
