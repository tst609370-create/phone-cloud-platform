# SP3-5: UHID Keyboard/Mouse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hardware-level keyboard and mouse input via scrcpy's UHID protocol (control message types 12/13/14), toggled on/off from the stream toolbar.

**Architecture:** Three new control message classes (Create/Input/Destroy) with standard HID report descriptors baked in. A `UhidManager` handles lifecycle (create on connect, destroy on disconnect). `UhidKeyboardHandler` maps DOM keydown/keyup to 8-byte USB HID keyboard reports. `UhidMouseHandler` uses pointer lock for relative mouse input with 4-byte HID mouse reports. A toggle button in GoogToolBox switches between existing touch/keycode mode and UHID mode.

**Tech Stack:** TypeScript, USB HID protocol, Pointer Lock API, BinaryWriter

**Spec:** `docs/specs/2026-04-11-sp3-feature-additions.md` (SP3-5 section)

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/app/controlMessage/UhidCreateMessage.ts` | UHID Create (type 12) with keyboard/mouse HID descriptors |
| `src/app/controlMessage/UhidInputMessage.ts` | UHID Input (type 13) for keyboard/mouse reports |
| `src/app/controlMessage/UhidDestroyMessage.ts` | UHID Destroy (type 14) |
| `src/app/googDevice/hid-usage-tables.ts` | KeyboardEvent.code → USB HID usage code mapping |
| `src/app/googDevice/UhidManager.ts` | Lifecycle: create/destroy UHID devices, send reports |
| `src/app/googDevice/UhidKeyboardHandler.ts` | DOM keydown/keyup → 8-byte keyboard HID reports |
| `src/app/googDevice/UhidMouseHandler.ts` | DOM mouse/wheel → 4-byte relative mouse HID reports |

### Modified Files
| File | Change |
|------|--------|
| `src/app/googDevice/toolbox/GoogToolBox.ts` | Add UHID toggle button |
| `src/app/googDevice/client/StreamClientScrcpy.ts` | Add uhidManager field, toggleUhid method |

---

## Task 1: Create UHID control message classes

**Files:**
- Create: `src/app/controlMessage/UhidCreateMessage.ts`
- Create: `src/app/controlMessage/UhidInputMessage.ts`
- Create: `src/app/controlMessage/UhidDestroyMessage.ts`

These follow the same BinaryWriter pattern as TouchControlMessage/ScrollControlMessage.

- [ ] **Step 1: Create UhidCreateMessage**

scrcpy UHID Create format: type(1) + id(2) + nameLength(2) + name(N) + descriptorLength(2) + descriptor(M)

```typescript
// src/app/controlMessage/UhidCreateMessage.ts
import { BinaryWriter } from '../BinaryWriter';
import { ControlMessage } from './ControlMessage';

// Standard USB HID keyboard report descriptor (8-byte reports)
// Modifier byte, reserved byte, 6 key slots
const KEYBOARD_DESCRIPTOR = new Uint8Array([
    0x05, 0x01,       // Usage Page (Generic Desktop)
    0x09, 0x06,       // Usage (Keyboard)
    0xa1, 0x01,       // Collection (Application)
    0x05, 0x07,       //   Usage Page (Key Codes)
    0x19, 0xe0,       //   Usage Minimum (224 = Left Control)
    0x29, 0xe7,       //   Usage Maximum (231 = Right Meta)
    0x15, 0x00,       //   Logical Minimum (0)
    0x25, 0x01,       //   Logical Maximum (1)
    0x75, 0x01,       //   Report Size (1)
    0x95, 0x08,       //   Report Count (8)
    0x81, 0x02,       //   Input (Data, Variable, Absolute) — modifier byte
    0x95, 0x01,       //   Report Count (1)
    0x75, 0x08,       //   Report Size (8)
    0x81, 0x01,       //   Input (Constant) — reserved byte
    0x95, 0x06,       //   Report Count (6)
    0x75, 0x08,       //   Report Size (8)
    0x15, 0x00,       //   Logical Minimum (0)
    0x25, 0x65,       //   Logical Maximum (101)
    0x05, 0x07,       //   Usage Page (Key Codes)
    0x19, 0x00,       //   Usage Minimum (0)
    0x29, 0x65,       //   Usage Maximum (101)
    0x81, 0x00,       //   Input (Data, Array) — 6 key slots
    0xc0,             // End Collection
]);

// Standard USB HID mouse report descriptor (4-byte reports)
// Buttons byte, dx int8, dy int8, wheel int8
const MOUSE_DESCRIPTOR = new Uint8Array([
    0x05, 0x01,       // Usage Page (Generic Desktop)
    0x09, 0x02,       // Usage (Mouse)
    0xa1, 0x01,       // Collection (Application)
    0x09, 0x01,       //   Usage (Pointer)
    0xa1, 0x00,       //   Collection (Physical)
    0x05, 0x09,       //     Usage Page (Buttons)
    0x19, 0x01,       //     Usage Minimum (Button 1)
    0x29, 0x05,       //     Usage Maximum (Button 5)
    0x15, 0x00,       //     Logical Minimum (0)
    0x25, 0x01,       //     Logical Maximum (1)
    0x95, 0x05,       //     Report Count (5)
    0x75, 0x01,       //     Report Size (1)
    0x81, 0x02,       //     Input (Data, Variable, Absolute) — buttons
    0x95, 0x01,       //     Report Count (1)
    0x75, 0x03,       //     Report Size (3)
    0x81, 0x01,       //     Input (Constant) — padding
    0x05, 0x01,       //     Usage Page (Generic Desktop)
    0x09, 0x30,       //     Usage (X)
    0x09, 0x31,       //     Usage (Y)
    0x09, 0x38,       //     Usage (Wheel)
    0x15, 0x81,       //     Logical Minimum (-127)
    0x25, 0x7f,       //     Logical Maximum (127)
    0x75, 0x08,       //     Report Size (8)
    0x95, 0x03,       //     Report Count (3)
    0x81, 0x06,       //     Input (Data, Variable, Relative) — dx, dy, wheel
    0xc0,             //   End Collection
    0xc0,             // End Collection
]);

export class UhidCreateMessage extends ControlMessage {
    private constructor(
        private readonly id: number,
        private readonly name: string,
        private readonly descriptor: Uint8Array,
    ) {
        super(ControlMessage.TYPE_UHID_CREATE);
    }

    static createKeyboard(id: number): UhidCreateMessage {
        return new UhidCreateMessage(id, 'ws-scrcpy keyboard', KEYBOARD_DESCRIPTOR);
    }

    static createMouse(id: number): UhidCreateMessage {
        return new UhidCreateMessage(id, 'ws-scrcpy mouse', MOUSE_DESCRIPTOR);
    }

    public toUint8Array(): Uint8Array {
        const nameBytes = new TextEncoder().encode(this.name);
        // type(1) + id(2) + nameLength(2) + name(N) + descriptorLength(2) + descriptor(M)
        const size = 1 + 2 + 2 + nameBytes.length + 2 + this.descriptor.length;
        return new BinaryWriter(size)
            .writeUInt8(this.type)
            .writeUInt16BE(this.id)
            .writeUInt16BE(nameBytes.length)
            .writeBytes(nameBytes)
            .writeUInt16BE(this.descriptor.length)
            .writeBytes(this.descriptor)
            .toUint8Array();
    }
}
```

- [ ] **Step 2: Create UhidInputMessage**

scrcpy UHID Input format: type(1) + id(2) + size(2) + data(N)

```typescript
// src/app/controlMessage/UhidInputMessage.ts
import { BinaryWriter } from '../BinaryWriter';
import { ControlMessage } from './ControlMessage';

export class UhidInputMessage extends ControlMessage {
    private constructor(
        private readonly id: number,
        private readonly data: Uint8Array,
    ) {
        super(ControlMessage.TYPE_UHID_INPUT);
    }

    static createKeyboardReport(id: number, modifier: number, keycodes: number[]): UhidInputMessage {
        // 8-byte keyboard report: modifier(1) + reserved(1) + key1-key6(6)
        const report = new Uint8Array(8);
        report[0] = modifier;
        report[1] = 0; // reserved
        for (let i = 0; i < Math.min(keycodes.length, 6); i++) {
            report[2 + i] = keycodes[i];
        }
        return new UhidInputMessage(id, report);
    }

    static createMouseReport(id: number, buttons: number, dx: number, dy: number, wheel: number): UhidInputMessage {
        // 4-byte mouse report: buttons(1) + dx(int8) + dy(int8) + wheel(int8)
        const report = new Uint8Array(4);
        report[0] = buttons;
        report[1] = Math.max(-127, Math.min(127, dx)) & 0xff;
        report[2] = Math.max(-127, Math.min(127, dy)) & 0xff;
        report[3] = Math.max(-127, Math.min(127, wheel)) & 0xff;
        return new UhidInputMessage(id, report);
    }

    public toUint8Array(): Uint8Array {
        // type(1) + id(2) + size(2) + data(N)
        return new BinaryWriter(1 + 2 + 2 + this.data.length)
            .writeUInt8(this.type)
            .writeUInt16BE(this.id)
            .writeUInt16BE(this.data.length)
            .writeBytes(this.data)
            .toUint8Array();
    }
}
```

- [ ] **Step 3: Create UhidDestroyMessage**

scrcpy UHID Destroy format: type(1) + id(2)

```typescript
// src/app/controlMessage/UhidDestroyMessage.ts
import { BinaryWriter } from '../BinaryWriter';
import { ControlMessage } from './ControlMessage';

export class UhidDestroyMessage extends ControlMessage {
    constructor(private readonly id: number) {
        super(ControlMessage.TYPE_UHID_DESTROY);
    }

    public toUint8Array(): Uint8Array {
        return new BinaryWriter(3)
            .writeUInt8(this.type)
            .writeUInt16BE(this.id)
            .toUint8Array();
    }
}
```

- [ ] **Step 4: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`

- [ ] **Step 5: Commit**

```bash
git add src/app/controlMessage/UhidCreateMessage.ts src/app/controlMessage/UhidInputMessage.ts src/app/controlMessage/UhidDestroyMessage.ts
git commit -m "feat(sp3-5): add UHID Create, Input, and Destroy control message classes"
```

---

## Task 2: Create HID usage tables

**Files:**
- Create: `src/app/googDevice/hid-usage-tables.ts`

Maps `KeyboardEvent.code` strings to USB HID usage codes. Standard 104-key US layout.

- [ ] **Step 1: Create hid-usage-tables.ts**

```typescript
// src/app/googDevice/hid-usage-tables.ts

/** Map KeyboardEvent.code → USB HID keyboard usage code (Usage Page 0x07). */
export const CODE_TO_HID: Record<string, number> = {
    // Letters
    KeyA: 0x04, KeyB: 0x05, KeyC: 0x06, KeyD: 0x07, KeyE: 0x08,
    KeyF: 0x09, KeyG: 0x0a, KeyH: 0x0b, KeyI: 0x0c, KeyJ: 0x0d,
    KeyK: 0x0e, KeyL: 0x0f, KeyM: 0x10, KeyN: 0x11, KeyO: 0x12,
    KeyP: 0x13, KeyQ: 0x14, KeyR: 0x15, KeyS: 0x16, KeyT: 0x17,
    KeyU: 0x18, KeyV: 0x19, KeyW: 0x1a, KeyX: 0x1b, KeyY: 0x1c,
    KeyZ: 0x1d,

    // Numbers
    Digit1: 0x1e, Digit2: 0x1f, Digit3: 0x20, Digit4: 0x21, Digit5: 0x22,
    Digit6: 0x23, Digit7: 0x24, Digit8: 0x25, Digit9: 0x26, Digit0: 0x27,

    // Control keys
    Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
    Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30,
    Backslash: 0x31, Semicolon: 0x33, Quote: 0x34,
    Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
    CapsLock: 0x39,

    // Function keys
    F1: 0x3a, F2: 0x3b, F3: 0x3c, F4: 0x3d, F5: 0x3e, F6: 0x3f,
    F7: 0x40, F8: 0x41, F9: 0x42, F10: 0x43, F11: 0x44, F12: 0x45,

    // Navigation
    PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
    Insert: 0x49, Home: 0x4a, PageUp: 0x4b,
    Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
    ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,

    // Numpad
    NumLock: 0x53,
    NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56,
    NumpadAdd: 0x57, NumpadEnter: 0x58,
    Numpad1: 0x59, Numpad2: 0x5a, Numpad3: 0x5b, Numpad4: 0x5c,
    Numpad5: 0x5d, Numpad6: 0x5e, Numpad7: 0x5f, Numpad8: 0x60,
    Numpad9: 0x61, Numpad0: 0x62, NumpadDecimal: 0x63,

    // Misc
    ContextMenu: 0x65,
};

/** HID modifier bit masks (byte 0 of keyboard report). */
export const HID_MODIFIER = {
    LEFT_CTRL: 0x01,
    LEFT_SHIFT: 0x02,
    LEFT_ALT: 0x04,
    LEFT_META: 0x08,
    RIGHT_CTRL: 0x10,
    RIGHT_SHIFT: 0x20,
    RIGHT_ALT: 0x40,
    RIGHT_META: 0x80,
} as const;

/** Map KeyboardEvent.code for modifier keys → HID modifier bit. */
export const MODIFIER_CODES: Record<string, number> = {
    ControlLeft: HID_MODIFIER.LEFT_CTRL,
    ShiftLeft: HID_MODIFIER.LEFT_SHIFT,
    AltLeft: HID_MODIFIER.LEFT_ALT,
    MetaLeft: HID_MODIFIER.LEFT_META,
    ControlRight: HID_MODIFIER.RIGHT_CTRL,
    ShiftRight: HID_MODIFIER.RIGHT_SHIFT,
    AltRight: HID_MODIFIER.RIGHT_ALT,
    MetaRight: HID_MODIFIER.RIGHT_META,
};
```

- [ ] **Step 2: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
git add src/app/googDevice/hid-usage-tables.ts
git commit -m "feat(sp3-5): add USB HID keyboard usage code mapping table"
```

---

## Task 3: Create UhidManager

**Files:**
- Create: `src/app/googDevice/UhidManager.ts`

Manages UHID device lifecycle: creates keyboard (id=1) and mouse (id=2) on init, destroys on teardown.

- [ ] **Step 1: Create UhidManager**

```typescript
// src/app/googDevice/UhidManager.ts
import type { ControlMessage } from '../controlMessage/ControlMessage';
import { UhidCreateMessage } from '../controlMessage/UhidCreateMessage';
import { UhidDestroyMessage } from '../controlMessage/UhidDestroyMessage';
import { UhidInputMessage } from '../controlMessage/UhidInputMessage';

export const UHID_KEYBOARD_ID = 1;
export const UHID_MOUSE_ID = 2;

export class UhidManager {
    private active = false;

    constructor(private readonly sendMessage: (msg: ControlMessage) => void) {}

    start(): void {
        if (this.active) return;
        this.active = true;
        this.sendMessage(UhidCreateMessage.createKeyboard(UHID_KEYBOARD_ID));
        this.sendMessage(UhidCreateMessage.createMouse(UHID_MOUSE_ID));
    }

    stop(): void {
        if (!this.active) return;
        this.active = false;
        this.sendMessage(new UhidDestroyMessage(UHID_KEYBOARD_ID));
        this.sendMessage(new UhidDestroyMessage(UHID_MOUSE_ID));
    }

    sendKeyReport(modifier: number, keycodes: number[]): void {
        if (!this.active) return;
        this.sendMessage(UhidInputMessage.createKeyboardReport(UHID_KEYBOARD_ID, modifier, keycodes));
    }

    sendMouseReport(buttons: number, dx: number, dy: number, wheel: number): void {
        if (!this.active) return;
        this.sendMessage(UhidInputMessage.createMouseReport(UHID_MOUSE_ID, buttons, dx, dy, wheel));
    }
}
```

- [ ] **Step 2: Verify build, commit**

```bash
git add src/app/googDevice/UhidManager.ts
git commit -m "feat(sp3-5): add UhidManager for UHID device lifecycle"
```

---

## Task 4: Create UhidKeyboardHandler

**Files:**
- Create: `src/app/googDevice/UhidKeyboardHandler.ts`

Listens to DOM keydown/keyup, maintains pressed key set, builds 8-byte HID keyboard reports.

- [ ] **Step 1: Create UhidKeyboardHandler**

```typescript
// src/app/googDevice/UhidKeyboardHandler.ts
import type { UhidManager } from './UhidManager';
import { CODE_TO_HID, MODIFIER_CODES } from './hid-usage-tables';

export class UhidKeyboardHandler {
    private pressedKeys = new Set<number>();
    private modifierState = 0;

    constructor(private readonly manager: UhidManager) {
        this.onKeyDown = this.onKeyDown.bind(this);
        this.onKeyUp = this.onKeyUp.bind(this);
    }

    attach(): void {
        document.addEventListener('keydown', this.onKeyDown);
        document.addEventListener('keyup', this.onKeyUp);
    }

    detach(): void {
        document.removeEventListener('keydown', this.onKeyDown);
        document.removeEventListener('keyup', this.onKeyUp);
        // Release all keys
        this.pressedKeys.clear();
        this.modifierState = 0;
        this.manager.sendKeyReport(0, []);
    }

    private onKeyDown(event: KeyboardEvent): void {
        event.preventDefault();

        const modBit = MODIFIER_CODES[event.code];
        if (modBit) {
            this.modifierState |= modBit;
            this.sendReport();
            return;
        }

        const hid = CODE_TO_HID[event.code];
        if (hid && !this.pressedKeys.has(hid)) {
            this.pressedKeys.add(hid);
            this.sendReport();
        }
    }

    private onKeyUp(event: KeyboardEvent): void {
        event.preventDefault();

        const modBit = MODIFIER_CODES[event.code];
        if (modBit) {
            this.modifierState &= ~modBit;
            this.sendReport();
            return;
        }

        const hid = CODE_TO_HID[event.code];
        if (hid) {
            this.pressedKeys.delete(hid);
            this.sendReport();
        }
    }

    private sendReport(): void {
        const keycodes = Array.from(this.pressedKeys).slice(0, 6);
        this.manager.sendKeyReport(this.modifierState, keycodes);
    }
}
```

- [ ] **Step 2: Verify build, commit**

```bash
git add src/app/googDevice/UhidKeyboardHandler.ts
git commit -m "feat(sp3-5): add UhidKeyboardHandler for DOM-to-HID keyboard input"
```

---

## Task 5: Create UhidMouseHandler

**Files:**
- Create: `src/app/googDevice/UhidMouseHandler.ts`

Uses Pointer Lock API for relative mouse input. Listens to mousemove/mousedown/mouseup/wheel on the player canvas.

- [ ] **Step 1: Create UhidMouseHandler**

```typescript
// src/app/googDevice/UhidMouseHandler.ts
import type { UhidManager } from './UhidManager';

export class UhidMouseHandler {
    private buttonState = 0;
    private readonly canvas: HTMLElement;

    constructor(
        private readonly manager: UhidManager,
        canvas: HTMLElement,
    ) {
        this.canvas = canvas;
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onWheel = this.onWheel.bind(this);
        this.onPointerLockChange = this.onPointerLockChange.bind(this);
    }

    attach(): void {
        this.canvas.addEventListener('click', this.requestPointerLock);
        document.addEventListener('pointerlockchange', this.onPointerLockChange);
    }

    detach(): void {
        this.canvas.removeEventListener('click', this.requestPointerLock);
        document.removeEventListener('pointerlockchange', this.onPointerLockChange);
        this.removeMouseListeners();
        if (document.pointerLockElement === this.canvas) {
            document.exitPointerLock();
        }
        this.buttonState = 0;
    }

    private requestPointerLock = (): void => {
        this.canvas.requestPointerLock();
    };

    private onPointerLockChange(): void {
        if (document.pointerLockElement === this.canvas) {
            this.addMouseListeners();
        } else {
            this.removeMouseListeners();
            // Release all buttons
            if (this.buttonState !== 0) {
                this.buttonState = 0;
                this.manager.sendMouseReport(0, 0, 0, 0);
            }
        }
    }

    private addMouseListeners(): void {
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('mouseup', this.onMouseUp);
        document.addEventListener('wheel', this.onWheel);
    }

    private removeMouseListeners(): void {
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('mousedown', this.onMouseDown);
        document.removeEventListener('mouseup', this.onMouseUp);
        document.removeEventListener('wheel', this.onWheel);
    }

    private onMouseMove(event: MouseEvent): void {
        const dx = Math.max(-127, Math.min(127, event.movementX));
        const dy = Math.max(-127, Math.min(127, event.movementY));
        if (dx !== 0 || dy !== 0) {
            this.manager.sendMouseReport(this.buttonState, dx, dy, 0);
        }
    }

    private onMouseDown(event: MouseEvent): void {
        this.buttonState |= 1 << event.button;
        this.manager.sendMouseReport(this.buttonState, 0, 0, 0);
    }

    private onMouseUp(event: MouseEvent): void {
        this.buttonState &= ~(1 << event.button);
        this.manager.sendMouseReport(this.buttonState, 0, 0, 0);
    }

    private onWheel(event: WheelEvent): void {
        event.preventDefault();
        const wheel = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
        if (wheel !== 0) {
            this.manager.sendMouseReport(this.buttonState, 0, 0, wheel);
        }
    }
}
```

- [ ] **Step 2: Verify build, commit**

```bash
git add src/app/googDevice/UhidMouseHandler.ts
git commit -m "feat(sp3-5): add UhidMouseHandler with pointer lock for relative mouse input"
```

---

## Task 6: Add UHID toggle to GoogToolBox + wire into StreamClientScrcpy

**Files:**
- Modify: `src/app/googDevice/toolbox/GoogToolBox.ts`
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`

- [ ] **Step 1: Add toggleUhid to StreamClientScrcpy**

In `src/app/googDevice/client/StreamClientScrcpy.ts`:

Add imports:
```typescript
import { UhidManager } from '../UhidManager';
import { UhidKeyboardHandler } from '../UhidKeyboardHandler';
import { UhidMouseHandler } from '../UhidMouseHandler';
```

Add fields (near the existing `private touchHandler?` field):
```typescript
    private uhidManager?: UhidManager;
    private uhidKeyboard?: UhidKeyboardHandler;
    private uhidMouse?: UhidMouseHandler;
```

Add method:
```typescript
    public toggleUhid(enabled: boolean): void {
        if (enabled) {
            if (this.uhidManager) return;
            this.uhidManager = new UhidManager((msg) => this.sendMessage(msg));
            this.uhidManager.start();

            // Attach UHID keyboard
            this.uhidKeyboard = new UhidKeyboardHandler(this.uhidManager);
            this.uhidKeyboard.attach();

            // Attach UHID mouse (uses player's touchable canvas element)
            if (this.player) {
                this.uhidMouse = new UhidMouseHandler(this.uhidManager, this.player.getTouchableElement());
                this.uhidMouse.attach();
            }

            // Disable existing touch handler
            this.touchHandler?.release();

            // Disable existing keyboard handler
            KeyInputHandler.removeEventListener(this);
        } else {
            // Destroy UHID
            this.uhidKeyboard?.detach();
            this.uhidMouse?.detach();
            this.uhidManager?.stop();
            this.uhidKeyboard = undefined;
            this.uhidMouse = undefined;
            this.uhidManager = undefined;

            // Re-enable touch handler
            if (this.player) {
                this.setTouchListeners(this.player);
            }
        }
    }
```

Also update `onDisconnected` to clean up UHID:
```typescript
    public onDisconnected = (): void => {
        this.audioPlayer?.stop();
        this.uhidKeyboard?.detach();
        this.uhidMouse?.detach();
        this.uhidManager?.stop();
        this.touchHandler?.release();
        this.touchHandler = undefined;
    };
```

Check that `KeyInputHandler` is imported (it should already be). The canvas element is accessed via `player.getTouchableElement()` (same method `FeaturedInteractionHandler` uses).

- [ ] **Step 2: Add UHID toggle button to GoogToolBox**

In `src/app/googDevice/toolbox/GoogToolBox.ts`, in `createToolBox()`:

Add import at top:
```typescript
import type { StreamClientScrcpy } from '../client/StreamClientScrcpy';
```
(Already imported — verify.)

After the keyboard checkbox block (around line 96), before the `moreBox` block, add:

```typescript
        const uhid = new ToolBoxCheckbox(
            'UHID Input (keyboard + mouse)',
            SvgImage.Icon.KEYBOARD,
            `uhid_input_${udid}_${playerName}`,
        );
        uhid.addEventListener('click', (_, el) => {
            const element = el.getElement();
            client.toggleUhid(element.checked);
        });
        elements.push(uhid);
```

Note: Reuses the KEYBOARD icon. If you want a different icon, check what's available in `SvgImage.Icon` — but KEYBOARD is fine for now since it represents input mode.

- [ ] **Step 3: Verify build**

Run: `npm run build:dev 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/app/googDevice/toolbox/GoogToolBox.ts src/app/googDevice/client/StreamClientScrcpy.ts
git commit -m "feat(sp3-5): add UHID toggle button to toolbar and wire into StreamClientScrcpy"
```

---

## Task 7: Smoke test

- [ ] **Step 1: Build and start server**

```bash
npm run build:dev && node dist/index.js
```

- [ ] **Step 2: Verify stream works without UHID**

Open `http://localhost:8000/`, click WebCodecs. Verify video streams normally, toolbar has the new UHID checkbox.

- [ ] **Step 3: Enable UHID**

Click the UHID checkbox in the toolbar. The checkbox should highlight. Click on the video canvas — pointer lock should activate (cursor disappears).

- [ ] **Step 4: Test UHID mouse**

Move the mouse — the Android cursor should move on screen. Click — should trigger tap. Scroll — should scroll. Press Escape to exit pointer lock.

- [ ] **Step 5: Test UHID keyboard**

With UHID enabled, type on the keyboard. Characters should appear in any focused text field on the Android device. If the device has a settings search bar or similar, open it and type.

- [ ] **Step 6: Disable UHID**

Uncheck the UHID checkbox. Touch/click interaction should return to normal (touch emulation mode). Keyboard capture checkbox should work independently again.

- [ ] **Step 7: Commit any fixes**
