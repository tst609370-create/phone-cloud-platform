# Modal Base Class Design Spec

Convert all ws-scrcpy-web modals from hand-rolled `<div>` overlays to native HTML `<dialog>` element with `.showModal()`. This spec covers the shared `Modal` abstract base class and `modal.css` — the foundation that all modals build on.

## Motivation

The current modal system uses manual DOM construction with `.dialog-background` (fixed-position div), `.dialog-container` (glassmorphism box), manual scroll lock (`document.body.style.overflow`), manual backdrop click detection, and manual Escape key listeners. This works but duplicates boilerplate across every modal and misses native platform features.

Native `<dialog>` with `.showModal()` provides:
- **Top layer rendering** — no z-index conflicts, always above everything
- **Automatic focus trapping** — tab/keyboard can't escape to the page behind
- **Built-in `::backdrop`** — native dimming pseudo-element
- **Pointer event blocking** — underlying page is fully inert
- **`cancel` event** — Escape key fires a cancel event (interceptable per-modal)
- **Eliminates manual hacks** — no scroll lock, no z-index management, no manual backdrop positioning

## Architecture: Abstract Base Class with Inheritance

`Modal` is an abstract class. Each modal extends it:

```
Modal (abstract)
  ├─ ConfigureScrcpyModal
  ├─ ShellModal
  ├─ ConnectModal
  └─ ListFilesModal
```

Inheritance over composition because these modals are complex components (WebSocket lifecycle, xterm.js terminals, video streams with UHID input) that happen to live in a modal. They need full lifecycle ownership, not just a dialog wrapper.

### Modal replaces BaseClient for modal classes

ConfigureScrcpy currently extends `BaseClient<ParamsStreamScrcpy, ConfigureScrcpyEvents>` (which extends `TypedEmitter`). Since TypeScript has single inheritance, ConfigureScrcpy drops BaseClient and extends Modal instead. What it used from BaseClient:

- `this.params` — becomes a regular instance property
- `this.emit('closed', ...)` — replaced by `onClose` callback (see below)
- `setTitle()` / `setBodyClass()` — not needed for modals (those are stream-page concerns)

BaseClient stays unchanged for non-modal clients like `StreamClientScrcpy`.

ShellModal has no existing inheritance (plain class), so it simply gains `extends Modal`.

## Class API

```typescript
// src/app/ui/Modal.ts

export interface ModalOptions {
    title: string;
    onClose?: (result: unknown) => void;
}

export abstract class Modal {
    protected readonly dialog: HTMLDialogElement;
    protected readonly bodyEl: HTMLElement;
    private readonly options: ModalOptions;

    constructor(options: ModalOptions);

    /** Required. Subclass fills the modal body content. */
    protected abstract buildBody(container: HTMLElement): void;

    /** Optional. Override to return a footer element. Default: no footer. */
    protected buildFooter(): HTMLElement | null;

    /** Override to handle Escape key. Default: this.close(). */
    protected onEscapeKey(event: Event): void;

    /** Override to handle backdrop click. Default: this.close(). */
    protected onBackdropClick(event: MouseEvent): void;

    /** Override to handle X button click. Default: this.close(). */
    protected onCloseButtonClick(): void;

    /** Override for cleanup before DOM removal. Default: no-op. */
    protected onBeforeClose(): void;

    /** Close the modal. Calls onBeforeClose, triggers CSS exit transition, removes from DOM, fires callback. */
    public close(result?: unknown): void;
}
```

### Close signaling via callbacks

Every modal has exactly one consumer. `onClose` callback replaces `TypedEmitter` events:

- **ConfigureScrcpyModal** — passes callback: `onClose: (result: boolean) => { if (result) startStream(); }`
- **ShellModal** — fire-and-forget, no callback
- **ConnectModal** — fire-and-forget, no callback
- **ListFilesModal** — fire-and-forget, no callback

Consumer-side change in `StreamClientScrcpy.ts`:
```typescript
// Before:
const dialog = new ConfigureScrcpy(tracker, descriptor, options);
dialog.on('closed', StreamClientScrcpy.onConfigureDialogClosed);

// After:
new ConfigureScrcpyModal(tracker, descriptor, options, {
    onClose: (result) => { if (result) HostTracker.getInstance().destroy(); }
});
```

## Dismiss Mechanics: Overridable Hook Methods

Each dismiss vector calls a protected hook method that subclasses override:

### Escape key

The browser fires a `cancel` event on the dialog when the user presses Escape. The base class always calls `preventDefault()` to maintain control over the close lifecycle, then delegates to the hook:

```typescript
this.dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    this.onEscapeKey(e);
});
```

### Backdrop click

Clicks on `::backdrop` bubble to the `<dialog>` element. Since the dialog has `padding: 0` and all visible content is inside a child `.modal-frame` div, clicks where `event.target === this.dialog` are backdrop clicks:

```typescript
this.dialog.addEventListener('click', (e) => {
    if (e.target === this.dialog) {
        this.onBackdropClick(e);
    }
});
```

### X button

Always present in the header. Calls `onCloseButtonClick()` which defaults to `this.close()`. ShellModal overrides this to show a confirmation prompt ("end session?") before closing, because closing destroys the terminal session and all output irreversibly.

### Per-modal dismiss policies

| Modal | Escape | Backdrop click | X button |
|-------|--------|---------------|----------|
| ConfigureScrcpyModal | close (default) | close (default) | close (default) |
| ShellModal | block (terminal key) | block (protect session) | confirm, then close |
| ConnectModal | block (UHID keyboard capture) | block (protect stream) | close (stream is stateless, device persists) |
| ListFilesModal | close (default) | close (default) | close (default) |

## DOM Structure

```html
<dialog class="modal">              <!-- padding:0, transparent, top layer -->
  ::backdrop                         <!-- native dimming overlay -->
  <div class="modal-frame">          <!-- glassmorphism box -->
    <div class="modal-header">
      <span class="modal-title">device name</span>
      <button class="modal-close">&times;</button>
    </div>
    <div class="modal-body">
      <!-- subclass content via buildBody() -->
    </div>
    <div class="modal-footer">       <!-- optional, via buildFooter() -->
      ...
    </div>
  </div>
</dialog>
```

- `dialog.modal` — invisible full-screen positioning layer. `padding: 0` is critical for backdrop click detection.
- `::backdrop` — native pseudo-element. Styled with `rgba(0, 0, 0, 0.45)` to match current dimming.
- `.modal-frame` — the visible glassmorphism container. Replaces the old `.dialog-container`. Centered by the native dialog centering mechanism (no manual flexbox needed).
- `.modal-header`, `.modal-body`, `.modal-footer` — same layout roles as the old `.dialog-header`, `.dialog-body`, `.dialog-footer`.

## Constructor Flow

```
new SomeModal(args)
  → super({ title, onClose? })
    → Modal constructor:
        1. Create <dialog class="modal">
        2. Create .modal-frame div (flex column)
        3. Build header: .modal-title span + .modal-close button (×)
        4. Create .modal-body container
        5. Call this.buildBody(bodyContainer)        ← subclass fills content
        6. Call this.buildFooter()                   ← returns element or null
        7. Assemble: dialog > frame > header + body + footer?
        8. Attach event listeners (cancel, click, close button)
        9. document.body.appendChild(dialog)
        10. dialog.showModal()                       ← triggers entry animation
```

## CSS Architecture

### New file: `src/style/modal.css`

Clean break from `dialog.css`. All selectors use `modal-*` prefix — no ambiguity during the coexistence period.

**What carries over from `dialog.css`:**
- Glassmorphism values: `rgba(30, 35, 45, 0.80)` background, `rgba(255,255,255,0.1)` border, `12px` border-radius, `0 8px 32px` box-shadow
- Light theme overrides via `[data-theme="light"]`
- Header/body/footer flex layout, padding, border separators
- Controls grid (`grid-template-columns: 35% 1fr`)
- Advanced section animated reveal (chevron toggle)
- Shell-modal-specific overrides (wider, taller, black body, terminal container)

**What changes:**
- `::backdrop` styled directly (replaces `.dialog-background` div)
- `@starting-style` + `transition-behavior: allow-discrete` replaces `@keyframes` animations
- Transitions on `.modal-frame` (opacity, transform) and `dialog::backdrop` (opacity) independently
- `dialog.modal { padding: 0; }` for backdrop click detection
- No manual scroll lock — `<dialog>.showModal()` makes the page inert natively

### Animations via `@starting-style`

Pure CSS open and close animations. No JavaScript timing, no `animationend` listeners, no edge cases with fast open-close or cancelled confirms.

**Entry:** `.modal-frame` transitions from `opacity: 0; scale(0.96); translateY(8px)` to resting state. `::backdrop` transitions from `opacity: 0` to `0.45`.

**Exit:** Same transitions play in reverse when the dialog closes. `transition-behavior: allow-discrete` enables animating the `display` property (`display: none ↔ block`), and `overlay` keeps the element in the top layer for the duration of the exit animation.

**Browser requirement:** Chromium 117+, Firefox 129+. This app already requires WebCodecs (similar browser floor), so no compatibility concern.

### Per-modal sizing via CSS classes

Base `.modal-frame` provides sensible defaults:
- Width: `clamp(400px, 50vw, 650px)`
- Max-height: `80vh`

Subclass overrides:
- `.shell-modal .modal-frame` — `clamp(500px, 90vw, 1600px)` wide, `90vh` max-height, `600px` min-height
- `.connect-modal .modal-frame` — sized at ConnectModal design time (likely near-fullscreen, aspect-ratio-aware)
- `.list-files-modal .modal-frame` — sized at ListFilesModal design time

Sizing classes are set by the subclass constructor: `this.dialog.classList.add('shell-modal')`.

## Subclass Contracts

### ConfigureScrcpyModal (convert existing)

- Drops `extends BaseClient`, becomes `extends Modal`
- `params` becomes a regular instance property
- `buildBody()` creates controls grid (display, codec, encoder, bitrate, fps), advanced section with chevron, settings buttons
- `buildFooter()` returns status text + connect button
- Uses default dismiss hooks (escape, backdrop, X all close)
- `close(true)` on connect, `close(false)` on cancel

### ShellModal (convert existing)

- Becomes `extends Modal`
- `buildBody()` creates resize warning text + terminal container div
- No footer
- `onEscapeKey()` — no-op (Escape is a valid terminal key)
- `onBackdropClick()` — no-op (protect the session)
- `onCloseButtonClick()` — shows "end session?" confirmation before closing (terminal session is destroyed on close, all output lost)
- `onBeforeClose()` — disposes xterm.js Terminal, disconnects WebSocket, stops ResizeObserver

### ConnectModal (build new — future step)

- `extends Modal`
- `buildBody()` creates video canvas + toolbar + touch/audio/UHID handlers (what `StreamClientScrcpy.start()` currently appends to `document.body`)
- No footer (toolbar is stream UI, not modal chrome)
- `onEscapeKey()` — no-op (UHID keyboard capture)
- `onBackdropClick()` — no-op (protect stream)
- Uses default `onCloseButtonClick()` — no confirmation needed (stream is stateless, device persists, reconnect anytime)
- `onBeforeClose()` — tears down stream, audio, WebSocket, UHID handlers

### ListFilesModal (build new — future step)

- `extends Modal`
- `buildBody()` creates file browser UI (redesigned from current full-page view)
- Uses default dismiss hooks (escape, backdrop, X all close — no active session to protect)
- Design details deferred to ListFilesModal spec

## File Layout

### New files
- `src/app/ui/Modal.ts` — abstract base class
- `src/style/modal.css` — `<dialog>` styles with `@starting-style` animations

### Modified files (during migration steps)
- `ConfigureScrcpy.ts` — drops `extends BaseClient`, becomes `extends Modal`
- `ShellModal.ts` — becomes `extends Modal`
- `StreamClientScrcpy.ts` — changes event listener to callback in constructor
- `DeviceTracker.ts` — minimal changes (ShellModal constructor may gain options parameter)
- Webpack config or entry point — add `modal.css` import

### Deleted after all conversions
- `src/style/dialog.css` — fully replaced by `modal.css`

### Not touched
- `BaseClient.ts` — stays as-is for non-modal clients
- `app.css` — body styles, theme variables, device view layout unchanged

## Migration Order

1. **Modal base class + modal.css** — the foundation (this spec)
2. **Convert ConfigureScrcpy** — simplest modal, validates the pattern
3. **Convert ShellModal** — validates dismiss hooks, close confirmation, terminal lifecycle
4. **Build ConnectModal** — full stream experience (separate spec needed)
5. **Build ListFilesModal** — file browser redesign (separate spec needed)
6. **Delete dialog.css** — after steps 2-3 complete, old styles are unused
