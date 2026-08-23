import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../../db/Db';
import { canAccessDevice } from '../deviceAccess';

const dirs: string[] = [];
afterEach(() => {
    Db._resetForTest();
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('canAccessDevice', () => {
    it('lets admins control all phones and tenants only their assignments', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsaccess-'));
        dirs.push(dir);
        const db = Db.getInstance(dir);
        const tenant = db.users.create({ username: 'ABCDEF', role: 'user', passwordHash: null });
        db.devices.setAssignments(tenant.id, ['PHONE-1']);
        expect(canAccessDevice(db, 1, 'OTHER')).toBe(true);
        expect(canAccessDevice(db, tenant.id, 'PHONE-1')).toBe(true);
        expect(canAccessDevice(db, tenant.id, 'OTHER')).toBe(false);
    });
});
