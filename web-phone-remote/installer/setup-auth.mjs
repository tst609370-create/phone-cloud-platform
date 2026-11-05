#!/usr/bin/env node
/**
 * Enable login on a ws-scrcpy-web database.
 * Password is read only from PHONE_REMOTE_ADMIN_PASSWORD (not argv, so it
 * does not show up in the process command line). This script prints OK and
 * never prints the password.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function hashPassword(plain) {
    const salt = randomBytes(16);
    const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

const dbPath = process.env.PHONE_REMOTE_DB;
const user = process.env.PHONE_REMOTE_ADMIN_USER || 'admin';
const password = process.env.PHONE_REMOTE_ADMIN_PASSWORD || '';

if (!dbPath || !password) {
    console.error('缺少数据库路径或密码环境变量');
    process.exit(2);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');
const admin = db.prepare('SELECT id FROM users WHERE id = 1').get();
if (!admin) {
    console.error('数据库里还没有管理员记录。请先成功启动一次服务。');
    process.exit(1);
}
db.prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = 1').run(user, hashPassword(password));
db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('authEnabled', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).run(JSON.stringify(true));
db.close();
console.log('OK');
