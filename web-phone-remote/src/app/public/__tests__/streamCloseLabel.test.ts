import { describe, expect, it } from 'vitest';
import { streamCloseLabel } from '../streamCloseLabel';

describe('streamCloseLabel', () => {
    it('keeps the socket scheme and close code and drops long secrets', () => {
        const label = streamCloseLabel(
            { code: 4005, reason: `scrcpy-server missing token=${'ab'.repeat(20)}` },
            'wss',
        );
        expect(label.startsWith('wss 4005 ')).toBe(true);
        expect(label).toContain('scrcpy-server missing');
        expect(label).toContain('[hidden]');
        expect(label.includes('ab'.repeat(20))).toBe(false);
    });

    it('uses ws when the page did not ask for a secure socket', () => {
        expect(streamCloseLabel(undefined, 'ws')).toBe('ws');
    });
});
