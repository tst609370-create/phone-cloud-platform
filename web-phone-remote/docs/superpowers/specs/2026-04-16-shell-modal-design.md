# Shell Modal — Design Spec

**Date:** 2026-04-16
**Scope:** Convert the ADB shell terminal from a full-page new-tab experience into a centered glassmorphism modal overlay, reusing the visual pattern from the configure stream modal.

---

## 1. Overview

The shell currently opens in a new browser tab as a full-page xterm.js terminal. This converts it to a modal overlay on the home page. The WebSocket connection, node-pty backend, and message protocol are unchanged — only the client-side rendering and lifecycle change.

## 2. Modal Shell

Same glassmorphism style as configure stream modal with these differences:

- **Sizing:** `width: clamp(500px, 70vw, 900px)`, `max-height: 90vh` — wider and taller than configure stream to give the terminal usable space
- **Backdrop:** Dimmed (rgba(0, 0, 0, 0.45)), no blur, same as configure stream
- **Container:** Semi-transparent (rgba(30, 35, 45, 0.80)), rounded corners, drop shadow
- **Dismiss:** X button only. No backdrop click dismiss. No Escape key dismiss. Escape is a valid terminal keystroke and accidental backdrop clicks would kill the session.

## 3. Layout Structure

### 3.1 Header

- Device name left-aligned (preserves original casing)
- X close button right-aligned
- Subtle bottom border

### 3.2 Body

- xterm.js Terminal instance fills the body
- Terminal container uses flex: 1 to consume all available vertical space
- FitAddon auto-sizes terminal columns/rows to the modal dimensions
- Black/dark background for the terminal area (standard xterm theme)
- No padding around terminal — edge-to-edge within the body for maximum space

### 3.3 Footer

None. The terminal is the entire content.

## 4. Behavior

### Session Lifecycle

1. User clicks "shell" on a device card → modal opens, WebSocket connects
2. WebSocket open → sends `{ type: 'start', rows, cols, udid }` message
3. Server spawns `adb -s <udid> shell` via node-pty
4. Terminal I/O streams over multiplexed WebSocket (ChannelCode.SHEL)
5. User clicks X → terminal disposed, WebSocket sends stop message, PTY killed, modal removed

### Dismiss Behavior

- **X button:** Closes modal, tears down terminal and WebSocket
- **Backdrop click:** Ignored (no dismiss)
- **Escape key:** Passed to terminal (no dismiss)

### Terminal Sizing

- FitAddon calculates rows/cols from modal body dimensions
- On window resize, FitAddon re-fits and sends updated dimensions to server
- Terminal container has no padding to maximize usable space

## 5. Text Casing

- Header device name: preserves original casing
- All other text lowercase per app motif

## 6. Implementation Approach

Rather than modifying ShellClient.ts (which handles the full-page routing and has its own BaseClient lifecycle), create a new lightweight class that:

1. Creates the modal DOM (reusing dialog.css classes)
2. Instantiates xterm.js Terminal + FitAddon + AttachAddon
3. Opens a WebSocket connection using the same multiplexing as ShellClient
4. Manages the modal lifecycle (open/close/cleanup)

The existing ShellClient.ts and server-side RemoteShell.ts stay unchanged — the new class reuses the same WebSocket protocol and channel code.

## 7. Click Interception

The "shell" link in device cards currently navigates to a new tab via `target="_blank"`. This changes to an event handler that opens the modal instead. The link becomes a button (or the click is intercepted with preventDefault).

## 8. Files Affected

| File | Change |
|------|--------|
| `src/app/googDevice/client/ShellModal.ts` | Create — modal class with xterm.js terminal |
| `src/style/dialog.css` | Add — shell-specific modal sizing overrides |
| `src/app/googDevice/client/DeviceTracker.ts` | Modify — intercept shell click, open modal instead of navigating |
| `src/app/googDevice/client/ShellClient.ts` | No change — full-page mode preserved for direct URL access |
| `src/server/goog-device/mw/RemoteShell.ts` | No change — server-side unchanged |

## 9. Not In Scope

- List files modal, connect modal (separate specs)
- Changes to WebSocket protocol or server-side RemoteShell
- Removing the full-page shell route (still accessible via direct URL)
