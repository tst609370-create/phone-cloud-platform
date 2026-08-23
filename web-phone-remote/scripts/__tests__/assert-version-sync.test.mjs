import { describe, expect, it } from 'vitest';
import {
    check,
    readCargoTomlVersion,
    readPackageJsonVersion,
    stripVPrefix,
} from '../assert-version-sync.mjs';

describe('stripVPrefix', () => {
    it('strips leading v', () => {
        expect(stripVPrefix('v0.1.0')).toBe('0.1.0');
        expect(stripVPrefix('v1.2.3-beta.1')).toBe('1.2.3-beta.1');
    });

    it('passes through non-v-prefixed', () => {
        expect(stripVPrefix('0.1.0')).toBe('0.1.0');
        expect(stripVPrefix('1.2.3-beta.1')).toBe('1.2.3-beta.1');
    });

    it('only strips a single leading v', () => {
        expect(stripVPrefix('vv0.1.0')).toBe('v0.1.0');
    });

    it('rejects non-string', () => {
        expect(() => stripVPrefix(undefined)).toThrow(/string/);
        expect(() => stripVPrefix(42)).toThrow(/string/);
    });
});

describe('readPackageJsonVersion', () => {
    it('extracts version field', () => {
        const json = '{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": {}\n}';
        expect(readPackageJsonVersion(json)).toBe('0.1.0');
    });

    it('handles prerelease versions', () => {
        const json = '{"version": "0.1.0-pre.1"}';
        expect(readPackageJsonVersion(json)).toBe('0.1.0-pre.1');
    });

    it('throws when version missing', () => {
        expect(() => readPackageJsonVersion('{"name": "x"}')).toThrow(/no "version" field/);
    });
});

describe('readCargoTomlVersion', () => {
    const sampleCargo = `[workspace]
members = ["a"]

[workspace.package]
version = "0.1.0"
edition = "2021"

[workspace.dependencies]
serde = { version = "1.0" }
`;

    it('extracts workspace.package version', () => {
        expect(readCargoTomlVersion(sampleCargo)).toBe('0.1.0');
    });

    it('does NOT pick up dependency versions', () => {
        const noWorkspaceVersion = `[workspace.dependencies]
serde = { version = "1.0" }
`;
        expect(() => readCargoTomlVersion(noWorkspaceVersion)).toThrow(/\[workspace\.package\]/);
    });

    it('throws when [workspace.package] missing', () => {
        expect(() => readCargoTomlVersion('[package]\nversion = "0.1.0"\n')).toThrow(
            /\[workspace\.package\]/,
        );
    });
});

describe('check', () => {
    it('passes when all three match', () => {
        const result = check({
            pkgVersion: '0.1.0',
            cargoVersion: '0.1.0',
            tagVersion: '0.1.0',
        });
        expect(result.ok).toBe(true);
        expect(result.version).toBe('0.1.0');
    });

    it('fails when any pair diverges', () => {
        expect(
            check({ pkgVersion: '0.1.0', cargoVersion: '0.1.0', tagVersion: '0.1.1' }).ok,
        ).toBe(false);
        expect(
            check({ pkgVersion: '0.1.0', cargoVersion: '0.0.0', tagVersion: '0.1.0' }).ok,
        ).toBe(false);
        expect(
            check({ pkgVersion: '0.0.0', cargoVersion: '0.1.0', tagVersion: '0.1.0' }).ok,
        ).toBe(false);
    });

    it('reports all three versions on failure', () => {
        const result = check({
            pkgVersion: '0.1.0',
            cargoVersion: '0.0.0',
            tagVersion: '0.1.1',
        });
        expect(result.ok).toBe(false);
        expect(result.pkgVersion).toBe('0.1.0');
        expect(result.cargoVersion).toBe('0.0.0');
        expect(result.tagVersion).toBe('0.1.1');
    });
});
