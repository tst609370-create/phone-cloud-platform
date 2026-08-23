import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeviceStore } from '../DeviceStore';
import { runMigrations } from '../migrations';
import { UserStore } from '../UserStore';

let db: DatabaseSync;
let store: DeviceStore;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    store = new DeviceStore(db);
});

describe('DeviceStore observed devices', () => {
    it('upserts and reads observed metadata (partial fields preserved)', () => {
        store.upsertDevice({ serial: 'S1', model: 'Pixel 7', lastSeenAt: 100 });
        store.upsertDevice({ serial: 'S1', address: '10.0.0.5:5555', lastSeenAt: 200 });
        expect(store.getDevice('S1')).toEqual({
            serial: 'S1',
            manufacturer: null,
            model: 'Pixel 7',
            address: '10.0.0.5:5555',
            lastSeenAt: 200,
        });
        expect(store.listDevices().length).toBe(1);
    });
});

describe('DeviceStore per-user labels', () => {
    it('sets/gets/deletes labels scoped per user', () => {
        // device_labels.user_id is an FK to users(id); create user 2 so the label
        // holds under foreign_keys=ON (the runtime opens with that pragma).
        new UserStore(db).create({ username: 'u2', role: 'user', passwordHash: null });
        store.setLabel(1, 'S1', 'Living Room');
        store.setLabel(2, 'S1', 'Office');
        expect(store.getLabel(1, 'S1')).toBe('Living Room');
        store.deleteLabel(1, 'S1');
        expect(store.getLabel(1, 'S1')).toBeUndefined();
        expect(store.getAllLabels(2)).toEqual({ S1: 'Office' });
    });
});

describe('DeviceStore rental assignments', () => {
    it('replaces a tenant assignment list and keeps each phone exclusive', () => {
        const users = new UserStore(db);
        const user2 = users.create({ username: 'CODE002', role: 'user', passwordHash: null });
        const user3 = users.create({ username: 'CODE003', role: 'user', passwordHash: null });
        store.setAssignments(user2.id, ['A', 'B']);
        expect(store.listAssignedSerials(user2.id)).toEqual(['A', 'B']);
        store.setAssignments(user3.id, ['B']);
        expect(store.listAssignedSerials(user2.id)).toEqual(['A']);
        expect(store.isAssignedTo(user3.id, 'B')).toBe(true);
        expect(store.assignmentOwners()).toEqual({ A: user2.id, B: user3.id });
    });
});
