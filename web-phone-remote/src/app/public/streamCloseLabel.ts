/** Visible stream failure text. Never includes tokens, passwords, or long hex secrets. */
export function streamCloseLabel(
    ev: { code?: number; reason?: string } | undefined,
    scheme: 'ws' | 'wss',
): string {
    const code = ev?.code;
    let reason = (ev?.reason ?? '').replace(/[\r\n\t]+/g, ' ').trim();
    reason = reason.replace(/[0-9a-f]{16,}/gi, '[hidden]');
    if (reason.length > 80) reason = reason.slice(0, 80);
    const parts = [scheme];
    if (typeof code === 'number' && code > 0) parts.push(String(code));
    if (reason) parts.push(reason);
    return parts.join(' ');
}
