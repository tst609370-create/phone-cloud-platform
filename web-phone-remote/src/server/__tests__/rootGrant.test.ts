import { describe, expect, it, vi } from 'vitest';
import { autoGrantWhile, findGrantButton, prepareMagiskPrompt } from '../rootGrant';

const MAGISK = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.topjohnwu.magisk" enabled="true" bounds="[60,700][1020,1400]">
<node index="0" text="超级用户请求" resource-id="com.topjohnwu.magisk:id/title" package="com.topjohnwu.magisk" bounds="[100,720][980,800]" />
<node index="1" text="Shell" resource-id="com.topjohnwu.magisk:id/app_name" package="com.topjohnwu.magisk" bounds="[100,820][980,880]" />
<node index="2" text="拒绝" resource-id="com.topjohnwu.magisk:id/deny_btn" package="com.topjohnwu.magisk" enabled="true" bounds="[100,1300][500,1380]" />
<node index="3" text="允许" resource-id="com.topjohnwu.magisk:id/grant_btn" package="com.topjohnwu.magisk" enabled="true" bounds="[580,1300][980,1380]" />
</node></hierarchy>`;

describe('Magisk prompt auto-grant', () => {
    it('finds the grant button, also under a hidden random package', () => {
        expect(findGrantButton(MAGISK)).toEqual({ x: 780, y: 1340 });
        expect(findGrantButton(MAGISK.replace(/com\.topjohnwu\.magisk/g, 'io.abcxyz.q'))).toEqual({ x: 780, y: 1340 });
    });

    it('does not tap ordinary screens', () => {
        expect(findGrantButton('<hierarchy><node text="允许" package="com.tencent.mm" bounds="[0,0][10,10]" /></hierarchy>')).toBeUndefined();
        expect(findGrantButton('')).toBeUndefined();
    });

    it('taps grant while su is waiting', async () => {
        let release!: () => void;
        const done = new Promise<void>((r) => (release = r));
        const shell = vi.fn(async (_s: string, cmd: string) => (cmd.startsWith('uiautomator') ? MAGISK : ''));
        const tapped = await autoGrantWhile({ shell }, 'X', done, 5_000);
        release();
        expect(tapped.tapped).toBe(true);
        expect(tapped.note).toContain('780,1340');
        expect(shell).toHaveBeenCalledWith('X', 'input tap 780 1340', 3_000);
    });

    it('stops as soon as su answered', async () => {
        const shell = vi.fn(async (_s: string, _c: string) => '');
        expect((await autoGrantWhile({ shell }, 'X', Promise.resolve(), 5_000)).tapped).toBe(false);
        expect(shell.mock.calls.some((c) => String(c[1]).startsWith('input tap'))).toBe(false);
    });

    it('lets Magisk pop its prompt from the background on MIUI', async () => {
        const shell = vi.fn(async (_s: string, cmd: string) =>
            cmd.startsWith('getprop') ? 'V12\nPKGS\npackage:com.topjohnwu.magisk\n' : '',
        );
        const note = await prepareMagiskPrompt({ shell }, 'M');
        expect(note).toContain('后台弹出界面');
        expect(shell).toHaveBeenCalledWith('M', expect.stringContaining('appops set com.topjohnwu.magisk 10021 allow'), 6_000);
    });
});
