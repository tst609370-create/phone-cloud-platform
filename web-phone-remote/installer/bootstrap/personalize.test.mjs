import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendInvite } from './personalize.mjs';

test('private trailer appends the invite and stdout never prints it', () => {
    const secret = 'ab'.repeat(32);
    const packed = appendInvite(Buffer.from('BASE'), secret);
    assert.equal(packed.subarray(0, 4).toString(), 'BASE');
    assert.equal(packed.subarray(-8).toString(), 'PRINVITE');
    const dir = mkdtempSync(path.join(tmpdir(), 'invite-'));
    const base = path.join(dir, 'base.exe');
    const out = path.join(dir, 'private.exe');
    const store = path.join(dir, 'enrollment.json');
    writeFileSync(base, Buffer.from('public-base'));
    const run = spawnSync(process.execPath, [
        path.join(import.meta.dirname, 'personalize.mjs'),
        '--base',
        base,
        '--out',
        out,
        '--store',
        store,
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.includes('inviteId='), true);
    const saved = JSON.parse(readFileSync(store, 'utf8'));
    const secretInFile = readFileSync(out).subarray(11, 11 + 64).toString();
    assert.equal(run.stdout.includes(secretInFile), false);
    assert.equal(run.stderr.includes(secretInFile), false);
    assert.equal(JSON.stringify(saved).includes(secretInFile), false);
    assert.equal(saved.invites[0].status, 'pending');
});

test('refuses to write a personalized exe into a public artifacts directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'invite-'));
    const base = path.join(dir, 'base.exe');
    writeFileSync(base, Buffer.from('public-base'));
    const run = spawnSync(process.execPath, [
        path.join(import.meta.dirname, 'personalize.mjs'),
        '--base',
        base,
        '--out',
        path.join(dir, 'artifacts', 'PhoneRemoteSetup.exe'),
        '--store',
        path.join(dir, 'enrollment.json'),
    ], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.equal(run.stdout.includes('inviteId='), false);
});
