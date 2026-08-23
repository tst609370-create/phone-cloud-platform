# ConnectModal Design Spec

Move the full stream experience (video canvas, toolbar, audio, UHID, touch input) from a full-page takeover into a native `<dialog>` modal overlay. The home page stays visible behind the dimmed backdrop. This spec covers ConnectModal, the StreamClientScrcpy container refactor, entry point wiring, and CSS scoping.

## Motivation

Currently, clicking "connect" navigates away from the device list entirely — `body.stream` takes over the whole page. The home page DOM stays in the background, invisible. When you disconnect, the device list reappears. This breaks multi-device workflows: you can't quickly switch between streams without navigating back and forth.

ConnectModal puts the stream inside a `<dialog>` overlay. Close it, you're back at your device list instantly. Consistent with ConfigureScrcpy and ShellModal behavior. And the container refactor directly lays the groundwork for the programmatic stream API (TODO item 6).

## Architecture: Thin Modal + Container Refactor

ConnectModal is a thin `Modal` subclass (~40 lines). It does almost nothing — the real work is a surgical refactor of `StreamClientScrcpy` to accept an optional `container` parameter instead of always appending to `document.body`.

```
ConnectModal extends Modal
  → constructor: super({ title, deviceLabel })
  → adds 'connect-modal' class for sizing
  → calls StreamClientScrcpy.start(params, player, ..., this.bodyEl)
  → stores the returned stop function for cleanup
```

### Why not absorb StreamClientScrcpy's logic?

`StreamClientScrcpy` manages the player, demuxer, toolbar, audio, UHID, touch handlers, and quality degradation detection. Moving all of that into ConnectModal would duplicate logic between the modal path and the embed mode path. Instead, StreamClientScrcpy stays the single source of truth for stream orchestration — it just renders into a provided container instead of assuming `document.body`.

## ConnectModal Class

```typescript
// src/app/googDevice/client/ConnectModal.ts

export class ConnectModal extends Modal {
    private stopStream?: () => void;

    constructor(
        params: ParamsStreamScrcpy,
        player: BasePlayer,
        fitToScreen: boolean,
        videoSettings: VideoSettings,
        deviceLabel: string,
    ) {
        super({ title: deviceLabel });
        this.dialog.classList.add('connect-modal');

        // Start the stream, rendering into this.bodyEl
        this.stopStream = StreamClientScrcpy.start(
            params, player, fitToScreen, videoSettings,
            this.bodyEl,
            () => this.close(),  // onDisconnect callback
        );
    }

    protected buildBody(container: HTMLElement): void {
        // Empty — StreamClientScrcpy populates the container after super()
    }

    protected onEscapeKey(_event: Event): void {}        // block — UHID keyboard capture
    protected onBackdropClick(_event: MouseEvent): void {} // block — protect stream

    protected onBeforeClose(): void {
        this.stopStream?.();
    }
}
```

Key points:
- `buildBody()` is intentionally empty. No ES2022 class field clobbering risk. The `stopStream` field is assigned after `super()` completes (in the constructor body, not during `buildBody()`), so ES2022 field initializer ordering is safe — initializer sets `undefined`, then constructor body overwrites with the real value.
- `StreamClientScrcpy.start()` returns a stop function (cleanup closure). ConnectModal stores it and calls it in `onBeforeClose()`.
- `start()` also accepts an `onDisconnect` callback — if the device disconnects or scrcpy-server crashes, the modal closes automatically.
- Escape and backdrop blocked (UHID keyboard capture, don't accidentally close). X button closes without confirmation (stream is stateless, device persists, reconnect anytime).

## StreamClientScrcpy Container Refactor

### Changes to `start()` signature

```typescript
// Before:
static start(params, player, fitToScreen, videoSettings): void

// After:
static start(
    params: ParamsStreamScrcpy,
    player: BasePlayer,
    fitToScreen: boolean,
    videoSettings: VideoSettings,
    container?: HTMLElement,        // render target (default: document.body)
    onDisconnect?: () => void,      // called when stream drops
): (() => void)                     // returns stop function
```

### Changes to `startStream()`

1. **DOM appending** — `document.body.appendChild(deviceView)` becomes `(container ?? document.body).appendChild(deviceView)`.

2. **Body class** — `this.setBodyClass('stream')` is skipped when `container` is provided. The home page stays untouched. The modal provides its own dark background via CSS.

3. **Stop function** — The existing `stop` closure (which removes deviceView, closes demuxer, stops audio/player) is returned from `start()` so ConnectModal can call it.

4. **Disconnect callback** — The existing `onDisconnected` handler additionally calls the `onDisconnect` callback (if provided) so ConnectModal can close itself when the server-side stream drops.

### What does NOT change

- `InteractionHandler.bindGlobalListeners()` — stays on `document.body`. Events inside the `<dialog>` bubble to `document.body` naturally. `showModal()` inertness prevents interaction with the page behind.
- `KeyInputHandler.attachListeners()` — stays on `document.body`.
- `UhidKeyboardHandler.attach()` / `UhidMouseHandler.attach()` — stay on `document`.
- Audio resume listeners — stay on `document` (events bubble).
- Embed mode path — still calls `start()` with no container, gets current `document.body` behavior.
- Stream quality auto-refresh — internal to StreamClientScrcpy, rebuilds demuxer within the same container.

### `getMaxSize()` sizing

Currently calculates max video dimensions from `window.innerHeight` and `window.innerWidth`. When in a container, it could use container dimensions, but there's a chicken-and-egg problem (container isn't sized until video is in it). Solution: keep using viewport dimensions for initial sizing (same as today). The video scales to fit available space via CSS max-height/max-width constraints. The modal frame auto-sizes around the result.

## Entry Points

### Path 1: Configure stream → Connect

```
"configure stream" button click
  → StreamClientScrcpy.onConfigureStreamClick()
    → new ConfigureScrcpy(tracker, descriptor, deviceLabel, options, callback)
      → User picks settings, clicks "connect"
        → ConfigureScrcpy.close(true)
          → callback creates player with selected settings
          → new ConnectModal(params, player, fitToScreen, videoSettings, deviceLabel)
```

Change in `StreamClientScrcpy.onConfigureStreamClick()`: the close callback creates a `ConnectModal` instead of calling `StreamClientScrcpy.start()` directly.

### Path 2: Direct connect

```
"connect" button click
  → handler reads device label from card DOM
  → auto-detects codec/encoder (existing detectBestCodecAndEncoder)
  → creates player
  → new ConnectModal(params, player, fitToScreen, videoSettings, deviceLabel)
```

Change in DeviceTracker / StreamClientScrcpy: the direct connect handler creates a `ConnectModal` instead of calling `StreamClientScrcpy.start()` with no container.

### Embed mode (unchanged)

```
?embed=true URL in iframe
  → StreamClientScrcpy.start(params, player, ...) — no container
  → document.body.appendChild(deviceView) — full-page as before
  → body.stream + body.embed classes applied as before
```

No changes to embed mode. The `body.stream` CSS rules stay permanently.

## Dismiss Mechanics

| Vector | Behavior |
|--------|----------|
| Escape | Blocked — UHID keyboard capture needs Escape |
| Backdrop click | Blocked — protect stream from accidental close |
| X button | Close (default) — no confirmation (stream is stateless, device persists) |
| Server disconnect | Auto-close via `onDisconnect` callback |

## CSS Architecture

### New rules in `modal.css` — scoped under `dialog.connect-modal`

**Modal frame — auto-width, capped height:**
```css
dialog.connect-modal .modal-frame {
    max-height: 90vh;
    width: auto;
    max-width: 95vw;
}
```

**Modal body — flex row, no padding, black background:**
```css
dialog.connect-modal .modal-body {
    padding: 0;
    display: flex;
    flex-direction: row;
    overflow: hidden;
    background: #000;
}
```

**Device view — flex instead of float:**
```css
dialog.connect-modal .device-view {
    display: flex;
    float: none;
}
```

**Video container — fill remaining space:**
```css
dialog.connect-modal .video {
    flex: 1;
    float: none;
    background: #000;
}
```

**Canvases — constrained to modal height:**
```css
dialog.connect-modal .video-layer,
dialog.connect-modal .touch-layer {
    max-height: calc(90vh - <header-height>);
    max-width: none;
}
```

The exact header height will be measured at implementation time (~2.5rem).

**Toolbar — fixed width, no float:**
```css
dialog.connect-modal .control-buttons-list {
    float: none;
    flex-shrink: 0;
}
```

**More-box — stays absolutely positioned:**

No CSS changes needed for `.more-box` — it already uses `position: absolute` and overlays from the right edge. It works inside the modal body because the body has `overflow: hidden` and is a positioned container.

### What stays untouched

- `body.stream` rules in `app.css` — permanently needed for embed mode
- `.control-button` styles — same everywhere
- All toolbar button/checkbox styles
- `.more-box` positioning and internal layout

## More-Box Changes

The disconnect button is removed from `GoogMoreBox.ts`. In the full-page stream, it was the only way to exit. In the modal, the X button in the header is the disconnect path. Everything else in the more-box stays: device info, text input, command buttons, stream parameter controls, screen power mode, quality stats toggle.

## Stream Lifecycle & Cleanup

### Opening

```
new ConnectModal(params, player, fitToScreen, videoSettings, deviceLabel)
  → super({ title: deviceLabel })
    → Creates <dialog class="modal connect-modal">
    → Builds header (device label + X)
    → Calls buildBody() — empty
    → Shows modal via dialog.showModal()
  → StreamClientScrcpy.start(params, player, ..., this.bodyEl, onDisconnect)
    → Creates deviceView > toolbar + video + moreBox
    → Appends deviceView to this.bodyEl (the modal body)
    → Connects demuxer, starts audio, attaches handlers
    → Returns stop function
  → ConnectModal stores stopStream function
```

### Closing (user clicks X)

```
X button click
  → Modal.close()
    → ConnectModal.onBeforeClose()
      → this.stopStream()
        → demuxer.close()
        → audioPlayer.stop()
        → uhidKeyboard.detach()
        → uhidMouse.detach()
        → touchHandler.release()
        → player.stop()
        → deviceView removed from parent
    → dialog.close() — triggers CSS exit animation
    → dialog.remove() — after 250ms fallback
```

### Closing (server disconnect)

```
scrcpy-server crashes or device disconnects
  → StreamClientScrcpy.onDisconnected fires
    → Internal cleanup (demuxer, audio, UHID, touch)
    → Calls onDisconnect callback
      → ConnectModal.close()
        → ConnectModal.onBeforeClose() — stopStream may be partially done
          → stopStream safely no-ops on already-cleaned components
        → dialog.close() + dialog.remove()
```

The stop function must be idempotent — calling it twice (once from onDisconnected internals, once from onBeforeClose) should not throw.

## File Layout

### New files
- `src/app/googDevice/client/ConnectModal.ts` — thin Modal subclass (~40 lines)

### Modified files
- `src/app/googDevice/client/StreamClientScrcpy.ts` — container parameter, stop function return, onDisconnect callback, skip setBodyClass when containerized
- `src/app/googDevice/client/DeviceTracker.ts` — "connect" link handler creates ConnectModal, reads device label
- `src/app/googDevice/toolbox/GoogMoreBox.ts` — remove disconnect button
- `src/style/modal.css` — add `dialog.connect-modal` rules
- `src/app/googDevice/client/ConfigureScrcpy.ts` — minor: callback creates ConnectModal instead of calling start()

### Not modified
- `src/app/ui/Modal.ts` — base class unchanged
- `src/app/googDevice/client/ShellModal.ts` — unrelated
- `src/app/googDevice/toolbox/GoogToolBox.ts` — toolbar creation unchanged
- `src/app/interactionHandler/InteractionHandler.ts` — listener attachment unchanged
- `src/app/googDevice/KeyInputHandler.ts` — unchanged
- `src/app/googDevice/UhidKeyboardHandler.ts` / `UhidMouseHandler.ts` — unchanged
- `src/app/player/BasePlayer.ts` / `WebCodecsPlayer.ts` — unchanged
- `src/style/app.css` — body.stream rules stay for embed mode
