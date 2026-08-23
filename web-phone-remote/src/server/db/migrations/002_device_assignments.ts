import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrations';

export const migration002: Migration = {
    version: 2,
    up(db: DatabaseSync): void {
        db.exec(`
            CREATE TABLE device_assignments (
                serial      TEXT PRIMARY KEY,
                user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                assigned_at INTEGER NOT NULL
            );
            CREATE INDEX idx_device_assignments_user ON device_assignments(user_id);
        `);
    },
};
