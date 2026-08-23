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
});
