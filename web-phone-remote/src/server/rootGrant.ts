/**
 * Auto-answer the Magisk superuser prompt that `adb shell su` raises the first
 * time, so a farm of rooted phones does not need someone to tap "允许" on each.
 *
 * While the su probe waits, we dump the screen with uiautomator and tap the
 * grant button of Magisk's SuRequest dialog (works when Magisk is hidden under
 * a random package too: the button id stays `…:id/grant_btn`). Once root works,
 * the Shell uid is written into Magisk's policy table as allowed forever.
 */

export interface GrantShell {
    shell(serial: string, command: string, timeoutMs?: number): Promise<string>;
}

export interface Point {
    x: number;
    y: number;
}

const GRANT_TEXT = /^(允许|永久允许|授权|授予|Grant|GRANT|Allow|ALLOW)$/;
const SU_DIALOG_HINT = /grant_btn|超级用户|Superuser|SuRequest|Shell|com\.android\.shell|magisk/i;

/** Center of Magisk's grant button in a uiautomator dump, if the prompt is showing. */
export function findGrantButton(xml: string): Point | undefined {
    if (!SU_DIALOG_HINT.test(xml)) return undefined;
    const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
    let byText: Point | undefined;
    for (const node of nodes) {
        const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(node)?.[1] ?? '';
        const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
        if (!bounds) continue;
        const [x1, y1, x2, y2] = bounds.slice(1).map(Number) as [number, number, number, number];
        if (x2 <= x1 || y2 <= y1) continue;
        const point = { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
        if (/:id\/grant_btn$/.test(attr('resource-id'))) return point;
        const pkg = attr('package');
        if (!byText && GRANT_TEXT.test(attr('text').trim()) && attr('enabled') !== 'false' && !/systemui|launcher/i.test(pkg)) {
            byText = point;
        }
    }
    // Text-only match is accepted only inside a Magisk-looking window.
    return byText && /magisk|超级用户|Superuser/i.test(xml) ? byText : undefined;
}

const DUMP = '/data/local/tmp/ws-su-ui.xml';

export interface GrantReport {
    tapped: boolean;
    /** What the screen showed, for the "no sound" hint. */
    note: string;
}

/** Package of the window on top in a uiautomator dump. */
export function topPackage(xml: string): string {
    return /<node\b[^>]*\bpackage="([^"]+)"/.exec(xml)?.[1] ?? '';
}

/**
 * Keep looking for the prompt until `done` resolves or `maxMs` passes; tap
 * grant once found.
 */
export async function autoGrantWhile(adb: GrantShell, serial: string, done: Promise<unknown>, maxMs = 12_000): Promise<GrantReport> {
    let finished = false;
    void done.finally(() => {
        finished = true;
    });
    const until = Date.now() + maxMs;
    // A dark screen hides the dialog from uiautomator.
    await adb.shell(serial, 'input keyevent KEYCODE_WAKEUP', 3_000).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 600));
    let dumps = 0;
    let lastTop = '';
    while (!finished && Date.now() < until) {
        let xml = '';
        try {
            xml = await adb.shell(serial, `uiautomator dump ${DUMP} >/dev/null 2>&1; cat ${DUMP}; rm -f ${DUMP}`, 5_000);
        } catch {
            xml = '';
        }
        if (finished) return { tapped: false, note: dumps ? `su 已返回，屏幕在 ${lastTop || '?'}` : 'su 很快返回，没弹授权框' };
        dumps++;
        if (xml.includes('<hierarchy')) lastTop = topPackage(xml) || lastTop;
        else if (!lastTop) lastTop = `截屏失败：${xml.replace(/\s+/g, ' ').trim().slice(0, 40)}`;
        const at = findGrantButton(xml);
        if (at) {
            const res = await adb.shell(serial, `input tap ${at.x} ${at.y}`, 3_000).catch((e: Error) => e.message);
            return { tapped: true, note: `看到授权框（${topPackage(xml)}），已点允许 (${at.x},${at.y})${res && res.trim() ? `：${res.trim().slice(0, 60)}` : ''}` };
        }
        await new Promise((r) => setTimeout(r, 400));
    }
    if (finished) return { tapped: false, note: dumps ? `su 已返回，屏幕在 ${lastTop || '?'}` : 'su 很快返回，没弹授权框' };
    return { tapped: false, note: `等了 ${Math.round(maxMs / 1000)} 秒没看到授权框，屏幕一直是 ${lastTop || '?'}` };
}

/**
 * MIUI stops apps from opening windows while in the background unless
 * "后台弹出界面" (MIUI app-op 10021) is allowed, so Magisk's su prompt never
 * shows and the request is silently denied. Allow it (shell may set app-ops).
 */
export async function prepareMagiskPrompt(adb: GrantShell, serial: string): Promise<string> {
    let out = '';
    try {
        out = await adb.shell(
            serial,
            'getprop ro.miui.ui.version.name; echo PKGS; pm list packages 2>/dev/null | grep -i -E "magisk|kernelsu|supersu|superuser"; true',
            8_000,
        );
    } catch {
        return '';
    }
    const [miuiPart = '', pkgPart = ''] = out.split('PKGS');
    const miui = miuiPart.trim();
    const pkgs = [...pkgPart.matchAll(/package:(\S+)/g)].map((m) => m[1]!);
    if (pkgs.length === 0) return '没找到 Magisk 应用（可能隐藏成了随机包名）';
    const notes = [`root 管理器 ${pkgs.join(',')}`];
    if (miui) {
        for (const pkg of pkgs) {
            await adb
                .shell(serial, `appops set ${pkg} 10021 allow; appops set ${pkg} SYSTEM_ALERT_WINDOW allow; appops set ${pkg} 10020 allow`, 6_000)
                .catch(() => undefined);
        }
        notes.push(`MIUI ${miui} 已给它开「后台弹出界面」`);
    }
    return notes.join('，');
}

/** SQL that makes Magisk allow the shell uid (2000) forever, logging/notify on. */
export const MAGISK_SHELL_FOREVER = "magisk --sqlite 'REPLACE INTO policies (uid,policy,until,logging,notification) VALUES(2000,2,0,1,1)'";
