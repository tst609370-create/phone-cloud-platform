import type { IncomingMessage, ServerResponse } from 'node:http';
import { AdbClient } from '../AdbClient';
import { resolveUserId } from '../auth/currentUser';
import { canAccessDevice } from '../auth/deviceAccess';
import { Config } from '../Config';
import { type DenoiseLevel, getDenoise, setDenoise } from '../micApp';
import { assertSerial } from '../security/deviceInput';
import { readJsonBody, sendInternalError } from './utils';

const LEVELS: DenoiseLevel[] = ['off', 'normal', 'strong'];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * POST /api/devices/audio-denoise {device, level: off|normal|strong}: noise reduction of
 * the no-root 「手机声音」 app (Android 8-10), applied live to a running stream.
 */
export class MicAudioApi {
    constructor(private readonly adb: Pick<AdbClient, 'shell'> = new AdbClient(Config.getInstance().adbPath)) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/api/devices/audio-denoise') return false;
        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        try {
            const body = await readJsonBody(req);
            let serial: string;
            try {
                serial = assertSerial(body['device']);
            } catch {
                sendJson(res, 400, { error: '设备序列号无效' });
                return true;
            }
            const level = body['level'] as DenoiseLevel;
            if (!LEVELS.includes(level)) {
                sendJson(res, 400, { error: 'level 只能是 off / normal / strong' });
                return true;
            }
            if (!canAccessDevice(Config.getInstance().db, resolveUserId(req), serial)) {
                sendJson(res, 403, { error: '设备未分配' });
                return true;
            }
            if (getDenoise(serial) !== level) await setDenoise(this.adb, serial, level);
            sendJson(res, 200, { level });
            return true;
        } catch {
            sendInternalError(res);
            return true;
        }
    }
}
