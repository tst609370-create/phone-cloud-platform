import type { IncomingMessage, ServerResponse } from 'http';
import QRCode from 'qrcode';
import { hashPassword } from '../auth/password';
import { requireAdmin } from '../auth/requireAdmin';
import { RENTAL_EXPIRES_AT_KEY, isRentalExpired, rentalExpiresAt } from '../auth/rentalExpiry';
import { SessionStore } from '../auth/session';
import { Config } from '../Config';
import { assertSerial } from '../security/deviceInput';
import { readJsonBodyStrict } from './utils';
import { RealtimeEventsApi } from './RealtimeEventsApi';

const NEW_CODE_PATTERN = /^[a-z]{2}[0-9]{6}$/;
const PUBLIC_LOGIN_URL = 'https://phone.anyuekf.cn/';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function code(value: unknown): string {
    const result = typeof value === 'string' ? value.trim() : '';
    if (!NEW_CODE_PATTERN.test(result)) throw new Error('识别码须为 2 个小写字母加 6 位数字');
    return result;
}

function expiresAt(value: unknown): number | null {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('租用到期时间无效');
    return value;
}

function label(value: unknown): string {
    const result = typeof value === 'string' ? value.trim() : '';
    if (!result || result.length > 64) throw new Error('备注须为 1-64 个字符');
    return result;
}

function devices(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 100) throw new Error('设备列表无效');
    return [...new Set(value.map((serial) => assertSerial(typeof serial === 'string' ? serial : null)))];
}

export class RentalsApi {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname !== '/api/rentals' && !pathname.startsWith('/api/rentals/')) return false;
        if (!requireAdmin(req, res)) return true;

        const db = Config.getInstance().db;
        try {
            if (req.method === 'GET' && pathname === '/api/rentals') {
                const rentals = db.users
                    .list()
                    .filter((user) => user.role === 'user')
                    .map((user) => ({
                        id: user.id,
                        code: user.username,
                        label: String(db.userSettings.get(user.id, 'rentalLabel') ?? user.username),
                        disabled: user.disabled,
                        expiresAt: rentalExpiresAt(db, user.id),
                        expired: isRentalExpired(db, user.id, Date.now()),
                        lastLogin: user.lastLoginAt,
                        devices: db.devices.listAssignedSerials(user.id),
                    }));
                sendJson(res, 200, { rentals, assignmentOwners: db.devices.assignmentOwners() });
                return true;
            }

            if (req.method === 'POST' && pathname === '/api/rentals') {
                const body = await readJsonBodyStrict(req);
                const accessCode = code(body['code']);
                const displayLabel = label(body['label']);
                const assigned = devices(body['devices']);
                const rentalEnd = body['expiresAt'] === undefined ? null : expiresAt(body['expiresAt']);
                if (db.users.getByUsername(accessCode)) {
                    sendJson(res, 409, { error: '识别码已存在' });
                    return true;
                }
                const passwordHash = hashPassword(accessCode);
                db.sqlite.exec('BEGIN');
                try {
                    const user = db.users.create({ username: accessCode, role: 'user', passwordHash });
                    db.userSettings.set(user.id, 'rentalLabel', displayLabel);
                    if (rentalEnd !== null) db.userSettings.set(user.id, RENTAL_EXPIRES_AT_KEY, rentalEnd);
                    db.devices.setAssignments(user.id, assigned);
                    db.sqlite.exec('COMMIT');
                    RealtimeEventsApi.publish('rentals');
                    sendJson(res, 201, { id: user.id });
                } catch (error) {
                    db.sqlite.exec('ROLLBACK');
                    throw error;
                }
                return true;
            }

            const idText = pathname.slice('/api/rentals/'.length);
            const qrMatch = idText.match(/^([0-9]+)\/qr$/);
            if (req.method === 'GET' && qrMatch) {
                const qrUser = db.users.getById(Number(qrMatch[1]));
                if (qrUser?.role !== 'user') {
                    sendJson(res, 404, { error: '租用码不存在' });
                    return true;
                }
                const svg = await QRCode.toString(PUBLIC_LOGIN_URL, {
                    type: 'svg',
                    errorCorrectionLevel: 'M',
                    margin: 2,
                    width: 320,
                    color: { dark: '#07111fff', light: '#ffffffff' },
                });
                res.writeHead(200, {
                    'content-type': 'image/svg+xml; charset=utf-8',
                    'cache-control': 'private, max-age=300',
                });
                res.end(svg);
                return true;
            }
            const id = Number(idText);
            const user = Number.isInteger(id) && String(id) === idText ? db.users.getById(id) : undefined;
            if (user?.role !== 'user') {
                sendJson(res, 404, { error: '租用码不存在' });
                return true;
            }

            if (req.method === 'PATCH') {
                const body = await readJsonBodyStrict(req);
                const nextCode = body['code'] === undefined ? undefined : code(body['code']);
                const nextLabel = body['label'] === undefined ? undefined : label(body['label']);
                const nextDevices = body['devices'] === undefined ? undefined : devices(body['devices']);
                const hasExpiresAt = Object.prototype.hasOwnProperty.call(body, 'expiresAt');
                const nextExpiresAt = hasExpiresAt ? expiresAt(body['expiresAt']) : undefined;
                if (
                    nextCode &&
                    nextCode.toLowerCase() !== user.username.toLowerCase() &&
                    db.users.getByUsername(nextCode)
                ) {
                    sendJson(res, 409, { error: '识别码已存在' });
                    return true;
                }
                const nextHash = nextCode ? hashPassword(nextCode) : undefined;
                db.sqlite.exec('BEGIN');
                try {
                    if (nextCode) db.users.setUsername(id, nextCode);
                    if (nextHash) db.users.setPasswordHash(id, nextHash);
                    if (nextLabel) db.userSettings.set(id, 'rentalLabel', nextLabel);
                    if (hasExpiresAt) {
                        if (nextExpiresAt === null) db.userSettings.delete(id, RENTAL_EXPIRES_AT_KEY);
                        else db.userSettings.set(id, RENTAL_EXPIRES_AT_KEY, nextExpiresAt);
                    }
                    if (nextDevices) db.devices.setAssignments(id, nextDevices);
                    if (typeof body['disabled'] === 'boolean') db.users.setDisabled(id, body['disabled']);
                    db.sqlite.exec('COMMIT');
                    if (nextCode || hasExpiresAt || body['disabled'] === true) {
                        new SessionStore(db.sqlite).deleteForUser(id);
                    }
                    RealtimeEventsApi.publish('rentals');
                    sendJson(res, 200, { ok: true });
                } catch (error) {
                    db.sqlite.exec('ROLLBACK');
                    throw error;
                }
                return true;
            }

            if (req.method === 'DELETE') {
                db.users.delete(id);
                RealtimeEventsApi.publish('rentals');
                sendJson(res, 200, { ok: true });
                return true;
            }
        } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : '操作失败' });
            return true;
        }
        sendJson(res, 405, { error: '不支持的操作' });
        return true;
    }
}
