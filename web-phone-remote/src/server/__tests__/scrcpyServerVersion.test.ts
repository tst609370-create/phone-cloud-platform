import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../../common/Constants';
import { getInstalledScrcpyServerVersion } from '../scrcpyServerVersion';

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

describe('bundled scrcpy-server version', () => {
    it('is the version the packaged server accepts at startup', () => {
        expect(bundledServerVersion()).toBe('4.1');
        expect(SERVER_VERSION).toBe(bundledServerVersion());
        expect(getInstalledScrcpyServerVersion(path.join(process.cwd(), 'does-not-exist'))).toBe('4.1');
    });
});
