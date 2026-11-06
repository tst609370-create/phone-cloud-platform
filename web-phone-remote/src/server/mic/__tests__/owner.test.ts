import { afterEach, describe, expect, it } from 'vitest';
import { claimMicOwner, resetMicOwnersForTests } from '../owner';

afterEach(() => {
    resetMicOwnersForTests();
});

describe('microphone inject slot', () => {
    it('lets a second controller take the phone after the first disconnects', () => {
        const firstOpen = { value: true };
        const first = claimMicOwner('COLAL10', () => firstOpen.value);
        expect(first).toBeTypeOf('function');
        expect(claimMicOwner('COLAL10', () => true)).toBeUndefined();
        first?.();
        expect(claimMicOwner('COLAL10', () => true)).toBeTypeOf('function');
    });

    it('replaces a holder whose socket is no longer open without letting the old release drop the new one', () => {
        const staleOpen = { value: false };
        const stale = claimMicOwner('COLAL10', () => staleOpen.value);
        const fresh = claimMicOwner('COLAL10', () => true);
        expect(fresh).toBeTypeOf('function');
        stale?.();
        expect(claimMicOwner('COLAL10', () => true)).toBeUndefined();
        fresh?.();
    });

    it('does not let one phone block another', () => {
        expect(claimMicOwner('PHONEA', () => true)).toBeTypeOf('function');
        expect(claimMicOwner('PHONEB', () => true)).toBeTypeOf('function');
    });
});
