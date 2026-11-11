(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.PhoneBrowserMic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function initialBrowserMic() {
        return { active: '', owner: '', paused: [], phase: 'idle' };
    }
    function same(state, patch, start, stop) {
        var paused = Object.prototype.hasOwnProperty.call(patch, 'paused') ? patch.paused : state.paused;
        return { state: Object.assign({}, state, patch, { paused: paused }), start: start || '', stop: !!stop };
    }
    function reduceBrowserMic(state, event) {
        if (event.type === 'activate') {
            const paused = state.paused.indexOf(event.serial) !== -1;
            if (paused) {
                return same(state, { active: event.serial, phase: 'closed-by-user', owner: '' }, '', state.owner !== '');
            }
            if (!event.gesture) return same(state, { active: event.serial, phase: 'needs-gesture', owner: '' }, '', state.owner !== '');
            if (state.owner === event.serial && (state.phase === 'capturing' || state.phase === 'requesting')) {
                return same(state, { active: event.serial });
            }
            return same(state, { active: event.serial, owner: event.serial, phase: 'requesting' }, event.serial, state.owner && state.owner !== event.serial);
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
            const paused = state.paused.indexOf(event.serial) === -1 ? state.paused.concat(event.serial) : state.paused;
            return same(state, { paused: paused, phase: 'closed-by-user', owner: state.owner === event.serial ? '' : state.owner }, '', state.owner === event.serial);
        }
        if (event.type === 'user-on') {
            const paused = state.paused.filter(function (serial) { return serial !== event.serial; });
            return same(state, { active: event.serial, owner: event.serial, paused: paused, phase: 'requesting' }, event.serial, state.owner && state.owner !== event.serial);
        }
        if (state.owner !== event.serial && state.active !== event.serial) return same(state, {});
        return same(state, { active: state.active === event.serial ? '' : state.active, owner: state.owner === event.serial ? '' : state.owner, phase: 'idle' }, '', state.owner === event.serial);
    }
    return { initialBrowserMic: initialBrowserMic, reduceBrowserMic: reduceBrowserMic };
});
