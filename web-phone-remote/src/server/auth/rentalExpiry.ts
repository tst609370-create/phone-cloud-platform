import type { Db } from '../db/Db';

export const RENTAL_EXPIRES_AT_KEY = 'rentalExpiresAt';

export function rentalExpiresAt(db: Db, userId: number): number | null {
    const value = db.userSettings.get(userId, RENTAL_EXPIRES_AT_KEY);
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function isRentalExpired(db: Db, userId: number, now: number): boolean {
    const user = db.users.getById(userId);
    if (user?.role !== 'user') return false;
    const expiresAt = rentalExpiresAt(db, userId);
    return expiresAt !== null && now >= expiresAt;
}
