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
        expect(source).toContain("frame.allow = 'autoplay; microphone; clipboard-read; clipboard-write; fullscreen'");
        expect(source).toContain("params.set('audio', card.dataset.hear === '1' ? 'true' : 'false')");
        expect(source).toContain('听声音');
        expect(source).toContain('不需要 root');
        // 只要求带缓存号，不写死具体版本，改版时不用同步改测试
        expect(publicFile('index.html')).toMatch(/phones\.js\?v=\d{8}\w*/);
        expect(publicFile('index.html')).toMatch(/browserMicPolicy\.js\?v=\d{8}\w*/);
        expect(source).toContain('开麦克风');
        expect(source).toContain("type: 'user-off'");
        expect(source).toContain('这不是手机未就绪');
        expect(source).toContain('startSnapshotAudio');
        expect(publicFile('index.html')).toMatch(/phoneAudio\.js\?v=\d{8}\w*/);
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

    it('sends long-side maxSize so 720p is not shrunk to 324x720', () => {
        const html = publicFile('index.html');
        const options = [...html.matchAll(/<option value="(\d+)"[^>]*>[^<]*?(\d+)p<\/option>/g)];
        expect(options.map((m) => m[2])).toEqual(['480', '720', '1080']);
        for (const [, value, label] of options) {
            // scrcpy max_size caps the longest side; a 20:9 phone needs ~2.2x the short side.
            expect(Number(value)).toBeGreaterThanOrEqual(Number(label) * 2.2);
        }
        const source = publicFile('phones.js');
        expect(source).toContain('requestedSize > 1600 ? 8000000 : requestedSize > 1080 ? 4000000 : 2000000');
    });

    it('always opens in smooth video mode', () => {
        const source = publicFile('phones.js');
        expect(source).toContain("let streamMode = 'video';");
        expect(source).not.toContain("localStorage.getItem('phone-stream-mode')");
    });

    it('streams at the chosen quality and reconnects to upgrade (scrcpy 4.1 ignores live settings)', () => {
        const source = publicFile('phones.js');
        expect(source).toContain('maxSize: requestedSize };');
        expect(source).not.toContain('displayMaxSize');
        const apply = source.slice(source.indexOf('function applyStreamProfile'), source.indexOf('function setState'));
        expect(apply).toContain('connect(card, true)');
        expect(apply).not.toContain("type: 'phone-stream-profile'");
    });

    it('uses Tianxi UI controls instead of native widgets', () => {
        const html = publicFile('index.html');
        const admin = publicFile('admin.html');
        const phones = publicFile('phones.js');
        const tianxi = publicFile('tianxi.js');
        // tianxi.js must load before phones.js so TX.toast exists when phones.js runs
        expect(html.indexOf('tianxi.js')).toBeGreaterThan(-1);
        expect(html.indexOf('tianxi.js')).toBeLessThan(html.indexOf('phones.js'));
        expect(html).toContain('tianxi.css');
        for (const page of [html, admin]) {
            for (const select of page.match(/<select\b[^>]*>/g) || []) expect(select).toContain('data-tx-select');
        }
        expect(phones).not.toMatch(/\balert\(/);
        expect(admin).not.toMatch(/(?<![.\w])confirm\(/);
        expect(admin).toContain('window.TX.enhance(');
        expect(tianxi).toContain('window.TX = { toast, confirm: confirmDialog');
    });
});

describe('phone wall preview grid', () => {
    it('keeps small windows view-only and operates the phone only when expanded', () => {
        const source = publicFile('phones.js');
        const css = publicFile('phones.css');
        expect(source).toContain("shield.addEventListener('click', () => expand(card))");
        expect(source).toContain("item.classList.contains('expanded')"); // keyboard only to the expanded phone
        expect(css).toMatch(/\.phone-card\.expanded \.preview-shield \{ display: none; \}/);
        expect(css).toMatch(/\.preview-shield \{[^}]*z-index: 7/);
        // previews stream light; expanded uses the full profile
        expect(source).toContain('bitrate: Math.min(PREVIEW_BITRATE, activeBitrate)');
    });
});
