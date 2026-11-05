import { describe, expect, it } from 'vitest';
import { resolveBindHost } from '../bindHost';

describe('resolveBindHost', () => {
    it('binds loopback only when the installer asks, and ignores other hosts', () => {
        expect(resolveBindHost(undefined)).toBeUndefined();
        expect(resolveBindHost('')).toBeUndefined();
        expect(resolveBindHost('127.0.0.1')).toBe('127.0.0.1');
        expect(resolveBindHost('localhost')).toBe('127.0.0.1');
        expect(resolveBindHost('0.0.0.0')).toBeUndefined();
        expect(resolveBindHost('103.205.240.23')).toBeUndefined();
    });
});
