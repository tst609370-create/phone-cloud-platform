import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInvite, emptyStore, redeemInvite, revokeDevice } from './enroll.mjs';
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

test('recovery exe and invite binding print ids only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'invite-'));
    const base = path.join(dir, 'base.exe');
    const out = path.join(dir, 'private.exe');
    const storeFile = path.join(dir, 'enrollment.json');
    writeFileSync(base, Buffer.from('public-base'));
    const store = emptyStore();
    const deviceId = 'a'.repeat(32);
    const enrolled = redeemInvite(store, createInvite(store).secret, deviceId);
    const pending = createInvite(store);
    writeFileSync(storeFile, JSON.stringify(store));
    const script = path.join(import.meta.dirname, 'personalize.mjs');
    const bound = spawnSync(process.execPath, [
        script,
        '--store',
        storeFile,
        '--bind-invite',
        pending.id,
        '--target-device',
        deviceId,
    ], { encoding: 'utf8' });
    assert.equal(bound.status, 0, bound.stderr);
    assert.equal(bound.stdout.includes(pending.secret), false);
    assert.equal(bound.stderr.includes(pending.secret), false);
    assert.equal(bound.stdout.includes(enrolled.deviceSecret), false);
    assert.equal(bound.stdout.includes(`inviteId=${pending.id}`), true);
    assert.equal(bound.stdout.includes(`targetDeviceId=${deviceId}`), true);
    const made = spawnSync(process.execPath, [
        script,
        '--base',
        base,
        '--out',
        out,
        '--store',
        storeFile,
        '--target-device',
        deviceId,
    ], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const saved = JSON.parse(readFileSync(storeFile, 'utf8'));
    const secretInFile = readFileSync(out).subarray(11, 11 + 64).toString();
    assert.equal(made.stdout.includes(secretInFile), false);
    assert.equal(made.stderr.includes(secretInFile), false);
    assert.equal(JSON.stringify(saved).includes(secretInFile), false);
    assert.equal(saved.invites.find((row) => row.id === pending.id).targetDeviceId, deviceId);
    assert.equal(saved.invites.some((row) => row.targetDeviceId === deviceId && row.status === 'pending' && row.id !== pending.id), true);
    revokeDevice(saved, deviceId);
    writeFileSync(storeFile, JSON.stringify(saved));
    const revived = spawnSync(process.execPath, [script, '--store', storeFile, '--authorize-device', deviceId], { encoding: 'utf8' });
    assert.equal(revived.status, 0, revived.stderr);
    assert.equal(revived.stdout.includes(secretInFile), false);
    assert.equal(revived.stdout.includes('authorized=1'), true);
    const authorized = JSON.parse(readFileSync(storeFile, 'utf8'));
    assert.equal(authorized.devices.find((row) => row.deviceId === deviceId).revoked, false);
});
