import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

function freshDb() {
    const dir = mkdtempSync(path.join(tmpdir(), 'auth-'));
    const dbPath = path.join(dir, 'wsscrcpy.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT)');
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, NULL)').run('admin');
    db.close();
    return dbPath;
}

test('setup-auth keeps an existing admin password', () => {
    const dbPath = freshDb();
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run('already-set');
    db.close();
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'setup-auth.mjs')], {
        encoding: 'utf8',
        env: { ...process.env, PHONE_REMOTE_DB: dbPath, PHONE_REMOTE_ADMIN_PASSWORD: 'new-secret' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.includes('KEEP'), true);
    assert.equal(run.stdout.includes('new-secret'), false);
    const after = new DatabaseSync(dbPath);
    const row = after.prepare('SELECT password_hash FROM users WHERE id = 1').get();
    assert.equal(row.password_hash, 'already-set');
    after.close();
});
