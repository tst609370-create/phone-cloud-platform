import { describe, expect, it } from 'vitest';
import { describeMicCaptureError } from '../micCapture';

describe('describeMicCaptureError', () => {
    it('explains a refusal without asking for another automatic prompt', () => {
        const err = new Error('denied');
        err.name = 'NotAllowedError';
        expect(describeMicCaptureError(err)).toContain('站点设置');
        expect(describeMicCaptureError(err)).toContain('不会自动再请求');
    });

    it('separates a missing device from a busy device', () => {
        const missing = new Error('none');
        missing.name = 'NotFoundError';
        const busy = new Error('busy');
        busy.name = 'NotReadableError';
        expect(describeMicCaptureError(missing)).toContain('没有找到麦克风');
        expect(describeMicCaptureError(busy)).toContain('占用');
    });
});
