export const MIC_HOLD_MS = 280;

/** Why the computer microphone cannot be used on this page, if it cannot. */
export function insecureMicReason(isSecureContext: boolean): string | undefined {
    if (isSecureContext) return undefined;
    return '当前页面不是安全上下文。通过公网 IP 的明文 HTTP 不能使用电脑麦克风。请在插着手机的电脑上打开 http://127.0.0.1 。远程开麦需要受信任的 HTTPS 证书；安装包没有公网证书，所以远程页面上的麦克风不可用。';
}

export interface MicGestureState {
    phase: 'idle' | 'pending' | 'ptt';
    continuous: boolean;
    downAt: number;
}

export type MicGestureEvent = { type: 'down' | 'up' | 'hold' | 'cancel'; now: number };

export type MicGestureEffect = 'ptt-start' | 'ptt-stop' | 'continuous-on' | 'continuous-off';

export function initialMicGesture(): MicGestureState {
    return { phase: 'idle', continuous: false, downAt: 0 };
}

export function reduceMicGesture(
    state: MicGestureState,
    event: MicGestureEvent,
): { state: MicGestureState; effects: MicGestureEffect[] } {
    if (event.type === 'down') {
        if (state.phase !== 'idle') return { state, effects: [] };
        return { state: { ...state, phase: 'pending', downAt: event.now }, effects: [] };
    }
    if (event.type === 'hold') {
        if (state.phase !== 'pending') return { state, effects: [] };
        if (state.continuous) return { state: { ...state, phase: 'ptt' }, effects: [] };
        return { state: { ...state, phase: 'ptt' }, effects: ['ptt-start'] };
    }
    if (event.type === 'cancel') {
        if (state.phase === 'ptt' && !state.continuous) {
            return { state: { ...state, phase: 'idle' }, effects: ['ptt-stop'] };
        }
        return { state: { ...state, phase: 'idle' }, effects: [] };
    }
    if (event.type === 'up') {
        if (state.phase === 'ptt') {
            if (state.continuous) return { state: { ...state, phase: 'idle' }, effects: [] };
            return { state: { ...state, phase: 'idle' }, effects: ['ptt-stop'] };
        }
        if (state.phase === 'pending') {
            const continuous = !state.continuous;
            return {
                state: { ...state, phase: 'idle', continuous },
                effects: [continuous ? 'continuous-on' : 'continuous-off'],
            };
        }
    }
    return { state, effects: [] };
}
