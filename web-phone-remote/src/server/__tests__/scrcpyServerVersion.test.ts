import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../../common/Constants';
import { getInstalledScrcpyServerVersion, writeInstalledScrcpyServerVersion } from '../scrcpyServerVersion';

function bundledServerVersion(): string {
    const jar = path.resolve(process.cwd(), 'assets/scrcpy-server');
    const dex = execFileSync('unzip', ['-p', jar, 'classes.dex'], { maxBuffer: 8 * 1024 * 1024 });
    const marker = Buffer.from('The server version (');
    const at = dex.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    const rest = dex.subarray(at + marker.length, at + marker.length + 16).toString('utf8');
    const version = rest.slice(0, rest.indexOf(')'));
    expect(version).toMatch(/^\d+\.\d+/);
    return version;
}

describe('getInstalledScrcpyServerVersion', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-version-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns marker contents when <deps>/scrcpy-server/.version is present', () => {
        const dir = path.join(tmpDir, 'scrcpy-server');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.version'), '4.0', 'utf8');
        expect(getInstalledScrcpyServerVersion(tmpDir)).toBe('4.0');
    });

    it('trims whitespace from marker contents', () => {
        const dir = path.join(tmpDir, 'scrcpy-server');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.version'), '  4.0\n', 'utf8');
        expect(getInstalledScrcpyServerVersion(tmpDir)).toBe('4.0');
    });

    it('falls back to SERVER_VERSION when marker is absent (legacy seed install)', () => {
        expect(getInstalledScrcpyServerVersion(tmpDir)).toBe(SERVER_VERSION);
    });

    it('falls back to SERVER_VERSION when marker exists but is empty', () => {
        const dir = path.join(tmpDir, 'scrcpy-server');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.version'), '', 'utf8');
        expect(getInstalledScrcpyServerVersion(tmpDir)).toBe(SERVER_VERSION);
    });
});

describe('writeInstalledScrcpyServerVersion', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-version-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes <deps>/scrcpy-server/.version with the given version', () => {
        writeInstalledScrcpyServerVersion(tmpDir, '4.0');
        const marker = path.join(tmpDir, 'scrcpy-server', '.version');
        expect(fs.readFileSync(marker, 'utf8')).toBe('4.0');
    });

    it('creates parent scrcpy-server directory if missing', () => {
        // No mkdir before write — helper must create the dir itself.
        writeInstalledScrcpyServerVersion(tmpDir, '4.0');
        expect(fs.existsSync(path.join(tmpDir, 'scrcpy-server'))).toBe(true);
    });

    it('overwrites an existing marker', () => {
        writeInstalledScrcpyServerVersion(tmpDir, '3.3.4');
        writeInstalledScrcpyServerVersion(tmpDir, '4.0');
        expect(getInstalledScrcpyServerVersion(tmpDir)).toBe('4.0');
    });
});

describe('bundled scrcpy-server version', () => {
    it('is the version the packaged server accepts at startup', () => {
        expect(bundledServerVersion()).toBe(SERVER_VERSION);
    });
});
