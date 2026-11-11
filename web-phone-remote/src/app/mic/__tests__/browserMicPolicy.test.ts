import { describe, expect, it } from 'vitest';
import { initialBrowserMic, reduceBrowserMic } from '../browserMicPolicy';

describe('default browser microphone', () => {
    it('asks only for the phone the user just opened', () => {
        const first = reduceBrowserMic(initialBrowserMic(), { type: 'activate', serial: 'A', gesture: true });
        expect(first.start).toBe('A');
        expect(first.state.phase).toBe('requesting');
        const granted = reduceBrowserMic(first.state, { type: 'granted' });
        expect(granted.state.phase).toBe('capturing');
        const other = reduceBrowserMic(granted.state, { type: 'activate', serial: 'B', gesture: false });
        expect(other.start).toBe('');
        expect(other.stop).toBe(true);
        expect(other.state.phase).toBe('needs-gesture');
    });

    it('does not restart after the user turns it off', () => {
        const on = reduceBrowserMic(initialBrowserMic(), { type: 'user-on', serial: 'A' });
        const off = reduceBrowserMic(on.state, { type: 'user-off', serial: 'A' });
        expect(off.stop).toBe(true);
        expect(off.state.phase).toBe('closed-by-user');
        const again = reduceBrowserMic(off.state, { type: 'activate', serial: 'A', gesture: true });
        expect(again.start).toBe('');
        expect(again.state.phase).toBe('closed-by-user');
        const manual = reduceBrowserMic(again.state, { type: 'user-on', serial: 'A' });
        expect(manual.start).toBe('A');
    });

    it('stops tracks when that card disconnects and does not open the rest', () => {
        const on = reduceBrowserMic(initialBrowserMic(), { type: 'activate', serial: 'A', gesture: true });
        const gone = reduceBrowserMic(on.state, { type: 'disconnect', serial: 'A' });
        expect(gone.stop).toBe(true);
        expect(gone.start).toBe('');
        expect(gone.state.phase).toBe('idle');
    });

    it('keeps a denial separate from a later manual retry', () => {
        const asking = reduceBrowserMic(initialBrowserMic(), { type: 'activate', serial: 'A', gesture: true });
        const denied = reduceBrowserMic(asking.state, { type: 'denied' });
        expect(denied.state.phase).toBe('denied');
        expect(denied.state.owner).toBe('');
    });
});
