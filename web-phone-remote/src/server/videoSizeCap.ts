/**
 * Per-device ceiling for scrcpy max_size, shared by every viewer.
 *
 * Some phone encoders emit solid-black (or no) frames above a certain size:
 * OnePlus 9 (LE21xx, ColorOS 14, OMX.qcom.video.encoder.avc) is black at the
 * 1600/2400 long-side steps and fine at 1080. Browsers report a black picture
 * (POST /api/settings/video-cap) and the server clamps every later session,
 * so phone browsers, other PCs and manual quality choices all stay at a size
 * that works.
 */
export const VIDEO_CAP_STEPS = [1080, 1600, 2400] as const;

/** Models known to go black above 1080 even before any browser reports it. */
const KNOWN_CAPS: Array<[RegExp, number]> = [[/^LE21\d\d$/i, 1080]];

export function capKey(serial: string): string {
    return `videoCap:${serial}`;
}

export function defaultCapForModel(model: string | undefined | null): number {
    if (!model) return 0;
    for (const [re, cap] of KNOWN_CAPS) if (re.test(model.trim())) return cap;
    return 0;
}

/** Effective max_size: 0 means "no limit" in scrcpy, so a cap replaces it. */
export function clampMaxSize(requested: number | undefined, cap: number): number | undefined {
    if (!(cap > 0)) return requested;
    if (!requested || requested > cap) return cap;
    return requested;
}

/** Only ever lower a stored cap (a later "ok" at a smaller size must not raise it). */
export function nextCap(stored: number, reported: number): number {
    if (!(reported > 0)) return stored;
    const step = [...VIDEO_CAP_STEPS].find((s) => s >= reported) ?? reported;
    return stored > 0 ? Math.min(stored, step) : step;
}
