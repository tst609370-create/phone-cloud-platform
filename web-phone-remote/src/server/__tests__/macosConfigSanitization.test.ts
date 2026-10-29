import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const macosDir = path.resolve(__dirname, '../../../macos');

describe('public macOS configuration templates', () => {
    it('does not allowlist a deployment-specific host by default', () => {
        const config = JSON.parse(readFileSync(path.join(macosDir, 'config.json'), 'utf8')) as {
            allowedHosts?: unknown;
        };

        expect(config.allowedHosts).toEqual([]);
    });

    it('does not contain a maintainer-specific home directory in the tunnel launch agent', () => {
        const plist = readFileSync(path.join(macosDir, 'cn.anyuekf.phonecloud.tunnel.plist'), 'utf8');

        expect(plist).not.toMatch(/\/Users\/(?!YOUR_USER\/)[^/<]+/);
    });

    it('keeps tunnel identifiers and public hostnames as placeholders', () => {
        const config = readFileSync(path.join(macosDir, 'cloudflared-config.yml'), 'utf8');

        expect(config).toMatch(/^tunnel:\s*YOUR_TUNNEL_UUID\s*$/m);
        expect(config).toMatch(/^\s*- hostname:\s*phone\.example\.com\s*$/m);
    });
});

describe('release third-party notices', () => {
    it('lists each production and optional runtime dependency', () => {
        const packageJson = JSON.parse(readFileSync(path.resolve(macosDir, '../package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
            optionalDependencies?: Record<string, string>;
        };
        const notices = readFileSync(path.resolve(macosDir, '../THIRD-PARTY-NOTICES.md'), 'utf8');

        for (const dependency of [
            ...Object.keys(packageJson.dependencies ?? {}),
            ...Object.keys(packageJson.optionalDependencies ?? {}),
            'dijkstrajs',
            'pngjs',
        ]) {
            expect(notices).toContain(`**${dependency}**`);
        }
    });
});

