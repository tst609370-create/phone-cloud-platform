import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const adminHtml = readFileSync(path.resolve(process.cwd(), 'public/admin.html'), 'utf8');
const phonesJs = readFileSync(path.resolve(process.cwd(), 'public/phones.js'), 'utf8');

describe('rental admin user controls', () => {
    it('offers inline device assignment and removal for every rental user', () => {
        expect(adminHtml).toContain('租用用户列表');
        expect(adminHtml).toContain('data-add-device');
        expect(adminHtml).toContain('data-remove-device');
        expect(adminHtml).toContain('已增加设备');
        expect(adminHtml).toContain('已移除设备');
    });

    it('keeps streams mounted while the browser is hidden', () => {
        expect(phonesJs).not.toContain("document.addEventListener('visibilitychange'");
        expect(phonesJs).not.toContain('if (document.hidden)');
    });

    it('includes a persistent APK library with multi-device install controls', () => {
        expect(adminHtml).toContain('APK 软件库');
        expect(adminHtml).toContain('data-install-apk');
        expect(adminHtml).toContain("api('/api/apks/install'");
        expect(adminHtml).toContain('安装到所选手机');
    });
});
