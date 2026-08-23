import type { IncomingMessage, ServerResponse } from 'http';
import { Config } from '../Config';
import type { Db } from '../db/Db';
import { resolveUserId } from './currentUser';
import { isRentalExpired } from './rentalExpiry';

export function canAccessDevice(db: Db, userId: number, serial: string): boolean {
    const user = db.users.getById(userId);
    return (
        user?.role === 'admin' ||
        (user?.disabled === false && !isRentalExpired(db, userId, Date.now()) && db.devices.isAssignedTo(userId, serial))
    );
}

export function requireDeviceAccess(req: IncomingMessage, res: ServerResponse, serial: string): boolean {
    if (canAccessDevice(Config.getInstance().db, resolveUserId(req), serial)) return true;
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'device not assigned' }));
    return false;
}
