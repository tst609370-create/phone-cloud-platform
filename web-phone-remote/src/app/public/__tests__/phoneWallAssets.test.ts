import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const publicFile = (name: string) => fs.readFileSync(path.join(process.cwd(), 'public', name), 'utf8');

describe('phone wall snapshot controls', () => {
    it('refreshes a settled frame and ignores stale input responses', () => {
        const source = publicFile('snapshot.js');
        expect(source).toContain('sequence !== inputSequence');
        expect(source).toContain("action.action === 'swipe' ? 450 : 240");
        expect(source).toContain("const tabs = ['首页', '朋友', '发布', '消息', '我']");
        expect(source).toContain('/api/devices/element?');
    });

    it('clicks snapshot navigation buttons and aligns the native layer to the canvas', () => {
        const source = publicFile('phones.js');
        expect(source).toContain("if (streamMode === 'snapshot')");
        expect(source).toContain('frameRect.left - cardRect.left + canvasRect.left');
        expect(source).toContain('frameRect.top - cardRect.top + canvasRect.top');
    });

    it('shows the shared APK library and installs into the active phone', () => {
        const html = publicFile('index.html');
        const source = publicFile('phones.js');
        expect(html).toContain('id="app-library"');
        expect(html).toContain('软件库');
        expect(source).toContain("fetch('/api/apks'");
        expect(source).toContain("fetch('/api/apks/install'");
        expect(source).toContain('devices: [card.dataset.device]');
    });

    it('recovers the device list after a service restart invalidates the instance cookie', () => {
        const source = publicFile('phones.js');
        expect(source).toContain('response.status !== 403');
        expect(source).toContain('/?refresh-token=');
        expect(source).toContain('response = await fetchConnectedDevices()');
    });
});
