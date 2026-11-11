export type BrowserMicPhase = 'idle' | 'needs-gesture' | 'requesting' | 'capturing' | 'denied' | 'closed-by-user';

export interface BrowserMicState {
    active: string;
    owner: string;
    paused: string[];
    phase: BrowserMicPhase;
}

export interface BrowserMicEffect {
    state: BrowserMicState;
    start: string;
    stop: boolean;
}

export function initialBrowserMic(): BrowserMicState {
    return { active: '', owner: '', paused: [], phase: 'idle' };
}

function same(state: BrowserMicState, patch: Partial<BrowserMicState>, start = '', stop = false): BrowserMicEffect {
    return { state: { ...state, paused: patch.paused ?? state.paused, ...patch }, start, stop };
}

/** One browser microphone for the phone the user is controlling. */
export function reduceBrowserMic(
    state: BrowserMicState,
    event:
        | { type: 'activate'; serial: string; gesture: boolean }
        | { type: 'granted' }
        | { type: 'denied' }
        | { type: 'user-off'; serial: string }
        | { type: 'user-on'; serial: string }
        | { type: 'disconnect'; serial: string },
): BrowserMicEffect {
    if (event.type === 'activate') {
        const paused = state.paused.includes(event.serial);
        if (paused) {
            return same(state, { active: event.serial, phase: 'closed-by-user', owner: '' }, '', state.owner !== '');
        }
        if (!event.gesture) {
            return same(state, { active: event.serial, phase: 'needs-gesture', owner: '' }, '', state.owner !== '');
        }
        if (state.owner === event.serial && (state.phase === 'capturing' || state.phase === 'requesting')) {
            return same(state, { active: event.serial });
        }
        return same(state, { active: event.serial, owner: event.serial, phase: 'requesting' }, event.serial, state.owner !== '' && state.owner !== event.serial);
    }
    if (event.type === 'granted') {
        if (state.phase !== 'requesting') return same(state, {});
        return same(state, { phase: 'capturing' });
    }
    if (event.type === 'denied') {
        if (state.phase !== 'requesting') return same(state, {});
        return same(state, { phase: 'denied', owner: '' });
    }
    if (event.type === 'user-off') {
        const paused = state.paused.includes(event.serial) ? state.paused : [...state.paused, event.serial];
        return same(state, { paused, phase: 'closed-by-user', owner: state.owner === event.serial ? '' : state.owner }, '', state.owner === event.serial);
    }
    if (event.type === 'user-on') {
        const paused = state.paused.filter((serial) => serial !== event.serial);
        return same(
            state,
            { active: event.serial, owner: event.serial, paused, phase: 'requesting' },
            event.serial,
            state.owner !== '' && state.owner !== event.serial,
        );
    }
    if (state.owner !== event.serial && state.active !== event.serial) return same(state, {});
    const stillActive = state.active === event.serial ? '' : state.active;
    return same(state, { active: stillActive, owner: state.owner === event.serial ? '' : state.owner, phase: 'idle' }, '', state.owner === event.serial);
}
