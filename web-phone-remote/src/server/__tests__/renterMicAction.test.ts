import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { INJECTABLE_AUDIO_SOURCES } from '../../common/micProtocol';
import { renterDeviceActionAllowed } from '../services/WebSocketServer';

describe('renter microphone access', () => {
    it('allows mic on an assigned device and still rejects other device sockets', () => {
        expect(renterDeviceActionAllowed('mic')).toBe(true);
        expect(renterDeviceActionAllowed('stream')).toBe(true);
        expect(renterDeviceActionAllowed('probe')).toBe(true);
        expect(renterDeviceActionAllowed('shell')).toBe(false);
        expect(renterDeviceActionAllowed('multiplex')).toBe(false);
    });
});

describe('LSPosed hook contract', () => {
    it('injects the same sources the server documents and skips REMOTE_SUBMIX', () => {
        const hook = readFileSync(
            'android/virtual-mic/lsposed-module/app/src/main/java/com/wsphone/virtualmic/AudioRecordHook.java',
            'utf8',
        );
        for (const source of INJECTABLE_AUDIO_SOURCES) {
            expect(hook).toContain(`case ${source}:`);
        }
        expect(hook).toContain('REMOTE_SUBMIX');
        expect(hook).not.toMatch(/case 8:/);
    });
});
