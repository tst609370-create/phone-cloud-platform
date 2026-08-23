# Configure Stream Modal — Design Spec

**Date:** 2026-04-16
**Scope:** Full redesign of the configure stream dialog from a left-pinned sidebar into a centered glassmorphism modal overlay.

---

## 1. Overview

Replace the current `ConfigureScrcpy` dialog (left-anchored slide-in panel) with a centered modal overlay. The modal probes the connected device for supported codecs/encoders, presents stream configuration options, and launches a mirroring session. This is the first of several modals — shell, list files, and connect will follow the same pattern.

## 2. Modal Shell

- **Backdrop:** Full-screen overlay with `backdrop-filter: blur(8px)` and ~70% opacity dark background
- **Modal container:** Semi-transparent background (`rgba(30, 35, 45, 0.85)`), faint border (`1px solid rgba(255,255,255,0.1)`), `border-radius: 12px`, drop shadow for depth
- **Sizing:** `width: clamp(400px, 50vw, 650px)`, `max-height: 80vh` with internal scroll on body overflow
- **Dismiss:** X button (top-right of header), backdrop click, Escape key — all close the modal and cancel any in-flight probe
- **Animation:** Fade-in on open

## 3. Layout Structure

Top to bottom within the modal:

### 3.1 Header

- Device name left-aligned (preserves original casing, e.g. "Google TV Streamer")
- X close button right-aligned, dimmed text color, brightens on hover
- Subtle bottom border separating header from body

### 3.2 Body

Padded content area, scrollable if content overflows. Contains three visual groups:

#### Stream Settings (always visible)

2-column grid layout, labels left, controls right. All labels lowercase:

| Control | Type | Notes |
|---------|------|-------|
| player | dropdown | Player implementation selection |
| display | dropdown | Display ID with resolution |
| video codec | dropdown | h264, h265, av1 — populated from device probe |
| audio codec | dropdown | opus, aac, flac, raw — populated from device probe |
| encoder | dropdown | Hardware preferred, populated from probe |
| bitrate | slider + inline label | 512 KB to 8 MB, label shows value (e.g. "7.5 mib") |
| max fps | slider + inline label | 1 to 60, label shows value (e.g. "15 fps") |

#### Advanced (collapsed by default)

Toggled by a full-width clickable "advanced" bar with a chevron icon that rotates 180 degrees on expand. Smooth CSS height animation (slide-down reveal) pushes settings/footer down. Visual separator line above the toggle bar. Same 2-column grid:

| Control | Type | Notes |
|---------|------|-------|
| i-frame interval | number input | |
| fit to screen | toggle switch | When on, disables max width/height |
| max width | number input | Disabled when fit to screen is on |
| max height | number input | Disabled when fit to screen is on |
| codec options | text input | Free-form codec options string |

Advanced section starts collapsed every time the modal opens (state not persisted).

#### Settings

Three buttons in a horizontal row: "reset", "load", "save". Styled with deep blue text (#5b9aff), white border, matching home page action buttons. All lowercase.

- **reset** — clears all controls to default values
- **load** — restores values from localStorage for this device
- **save** — writes current values to localStorage for this device, brief visual confirmation (text flashes "saved", returns to "save")

### 3.3 Footer

- Status text left-aligned: "probing..." (red, #f06c75) while device probe runs, "ready" (green, #4ade80) on success, error message (red) on failure
- "connect" button right-aligned: deep blue text, white border. Disabled + dimmed while probing. All lowercase.
- Subtle top border separating footer from body

## 4. Visual Style

- Inherits existing app theme variables (dark/light mode via `data-theme` attribute)
- **Dropdowns and inputs:** dark background (`var(--stream-bg-color)`), subtle border, rounded corners
- **Sliders:** styled track with colored fill, value displayed as inline label next to slider
- **Advanced toggle:** dimmed text, chevron right-aligned, no border — just a separator line above. Rotates chevron on expand.
- **Buttons:** deep blue text (#5b9aff), `0.5px solid var(--text-color)` border, `border-radius: 6px`, transparent background, hover lightens with blue tint (`var(--device-list-hover-color)`)
- **X close button:** dimmed text color, brightens on hover, no border/background
- **Glass effect:** The modal container uses semi-transparent background + backdrop blur on the overlay behind it, plus a faint white border for the frosted edge look

## 5. Behavior

### Probe Flow

1. Modal opens → probe fires immediately via `DeviceProbe`
2. Status shows "probing...", connect button disabled, dropdowns empty/disabled
3. Probe completes → dropdowns populate, best codec/encoder auto-selected (H.265 > H.264 > AV1, hardware encoders preferred), status flips to "ready", connect button enables
4. Probe fails → status shows error in red, connect button stays disabled

### Connect

Builds `ParamsStreamScrcpy` from all form values (same as current `openStream()` logic), starts the stream, modal closes.

### Scroll

If body content overflows (advanced expanded on small screen), body section scrolls internally. Header and footer stay pinned.

## 6. Text Casing

All UI text lowercase per app motif, with exceptions:
- Device names and models preserve original casing
- Home page section headings preserve title case

## 7. Scope

This spec covers only the configure stream modal. Shell, list files, and connect modals will follow in separate specs, reusing the modal shell pattern established here.

## 8. Files Affected

| File | Change |
|------|--------|
| `src/app/googDevice/client/ConfigureScrcpy.ts` | Rewrite `createUI()` — new modal structure, advanced toggle, layout |
| `src/style/dialog.css` | Replace with glassmorphism modal styles, responsive sizing, animations |
| `src/app/googDevice/client/StreamClientScrcpy.ts` | Minor — update `onConfigureStreamClick` if constructor API changes |
| `src/style/devicelist.css` | None expected — button styles already in place |

## 9. Not In Scope

- Shell modal, list files modal, connect modal (separate specs)
- Changes to probe logic or codec detection (working correctly today)
- Settings persistence format changes (continues using localStorage)
- Dark/light theme variable changes (inherits existing)
