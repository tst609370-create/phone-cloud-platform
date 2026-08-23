# ListFilesModal Design Spec

Full redesign of the file manager as a modern file browser inside a native `<dialog>` modal. Replaces the current full-page new-tab file listing with a glassmorphism overlay that stays on the home page. Includes breadcrumb navigation, sortable columns, selection with bulk operations, drag-and-drop upload, download progress, delete with confirmation, client-side filtering, configurable icon sizes, and SVG file type icons.

## Motivation

The current file manager is a full-page experience that opens in a new tab. It uses a plain HTML table, base64 PNG icons, hash-based navigation, and has no selection, no bulk operations, no delete, no search, and no visual consistency with the rest of the app. Every other feature (configure stream, shell, connect) now lives in a modal. The file manager is the last holdout.

## Modal Structure

```
<dialog class="modal list-files-modal">
  ::backdrop
  <div class="modal-frame">
    ┌──────────────────────────────────────────────────────┐
    │ Header: device label                       [⊞]  [X] │
    ├──────────────────────────────────────────────────────┤
    │ Breadcrumbs: / storage / emulated / 0      [filter…] │
    ├──────────────────────────────────────────────────────┤
    │ [☐] Name ▲                          Size       Date  │
    │ ─────────────────────────────────────────────────────│
    │  ☐  📁 DCIM                                          │
    │  ☐  📁 Download                                      │
    │  ☐  📄 readme.txt                 2.4 KB    Apr 16   │
    │  ☐  🖼️ photo.jpg                  3.2 MB    Apr 15   │
    │  ☐  🎵 track.mp3                  4.1 MB    Apr 14   │
    │                   (scrollable)                       │
    ├──────────────────────────────────────────────────────┤
    │ [upload] [delete] [download]       2 selected │ 8 items│
    └──────────────────────────────────────────────────────┘
  </div>
</dialog>
```

### ListFilesModal extends Modal

- Header: device label + icon size picker button `[⊞]` + X close button
- The `[⊞]` button sits left of X with enough spacing to avoid misclicks
- Tooltip on hover: "icon size preference"
- Breadcrumb bar: clickable path segments + filter input (separate row below header)
- File list: scrollable area with sortable column headers
- Footer: action buttons LEFT, selection count + total items RIGHT

### Modal sizing

- Width: `clamp(500px, 70vw, 900px)`
- Max-height: `85vh`
- File list area scrolls independently (not the whole modal)

### Dismiss behavior

- Escape, backdrop click, X all close (default Modal behavior)
- ALL three dismiss vectors check for active transfers — `onEscapeKey()`, `onBackdropClick()`, and `onCloseButtonClick()` all show confirmation ("transfers in progress — close anyway?") if any upload or download is active
- No confirmation when no transfers are active — all three vectors close immediately

## Icon Size Preference

### First open (no localStorage)

Before the file listing loads, a size picker dialog appears inside the modal body:
- Five visual options: 16px, 20px, 24px, 28px, 32px — each shown with a sample row so the user can see the density
- Checkbox: "save preference (skip this dialog next time)"
- OK button confirms selection → size applied, file listing loads

### Subsequent opens (preference saved)

Files load immediately at the saved size. No picker dialog.

### Changing preference later

The `[⊞]` button in the header opens the same size picker (replaces the file listing temporarily). If "save preference" is already checked, a note appears: "uncheck and click OK to clear saved preference." Uncheck + OK → clears `localStorage` key, next session shows the picker again.

### Implementation

- CSS custom property `--file-icon-size` on the dialog element controls icon width/height and row padding
- Five presets: 16px, 20px, 24px, 28px, 32px
- Changing the property instantly reflows the list (no modal restart)
- `localStorage` key: `file-browser-icon-size`
- Default when no preference: show picker (no assumed size)

## Breadcrumb Navigation

Separate row below the header, two parts: path segments left, filter input right.

### Path segments

- Each directory in the current path is a clickable segment: `/ storage / emulated / 0`
- Root `/` is always the first segment (clickable — jumps to root)
- Clicking any segment navigates to that directory
- Segments styled as subtle pills (`rgba(91,154,255,0.15)` background, rounded corners)
- Last segment (current directory) is plain text, not a link
- Horizontal scroll if path overflows (no wrapping, no truncation)

### Filter input

- Small search/filter icon + text input on the right end of the breadcrumb bar
- Filters the current file list as you type (client-side, instant)
- Filters by filename only (not size or date)
- Clearing the input restores the full listing
- Placeholder text: "filter..."
- Filter resets when navigating to a new directory

### No back/forward buttons

Breadcrumbs ARE the navigation. Click any ancestor to go back. Each directory loads fresh from the device (no client-side caching).

## File List

### Column headers

| Column | Sortable | Default | Click behavior |
|--------|----------|---------|----------------|
| Select-all checkbox | No | Unchecked | Toggles all checkboxes in current directory |
| Name | Yes | Ascending | Toggle ascending/descending |
| Size | Yes | — | Toggle ascending/descending |
| Date | Yes | — | Toggle ascending/descending |

- Small arrow indicator (▲/▼) next to the active sort column
- Default sort: Name ascending
- Directories always sort first (grouped above files, regardless of sort column)
- Sort is client-side (full listing already loaded)
- Sort resets to default when navigating to a new directory

### File rows

Each row contains:
- Checkbox (left edge)
- File type SVG icon (sized by `--file-icon-size`)
- Filename
- File size (right-aligned, dimmed — directories show nothing)
- Modified date (right-aligned, dimmed — short format: "Apr 16")
- Hover actions: download `[↓]` and delete `[×]` buttons (appear on hover, far right)

### Row interactions

| Element | Directory | File |
|---------|-----------|------|
| Click row | Navigate into directory | Nothing (use hover buttons or checkbox) |
| Checkbox | Select for bulk operations | Select for bulk operations |
| Hover `[↓]` | Not shown | Download single file |
| Hover `[×]` | Delete directory (confirm) | Delete single file (confirm) |

### Visual states

- Default: transparent background
- Hover: subtle highlight (`rgba(255,255,255,0.04)`)
- Selected (checkbox checked): blue tint (`rgba(91,154,255,0.08)`)
- Uploading: progress bar fills row background (animated width)
- Downloading: progress bar in the row

### Symlinks

Shown with the icon matching their target type. Small overlay arrow (bottom-left corner) on the icon. If target type can't be determined, use generic file icon.

## Footer

### Layout

```
[upload] [delete selected] [download selected]       2 selected | 8 items
└─── action buttons (LEFT) ───┘                    └─── info (RIGHT) ───┘
```

Action buttons on the LEFT (less mouse traversal — close to the files above). Selection count + total items on the RIGHT.

### Button states

| Selection contains | Upload | Download | Delete |
|---|---|---|---|
| Files only | Enabled | Enabled | Enabled |
| Directories only | Enabled | Disabled | Enabled |
| Mixed (files + dirs) | Enabled | Disabled | Enabled |
| Nothing selected | Enabled | Disabled | Disabled |

Upload is always enabled (pushes to current directory, independent of selection). Download disables when any directory is selected (recursive pull over ADB is too complex/slow). Delete works on both files and directories.

## File Transfer UX

### Upload

- **Upload button** in footer opens a native file picker (`<input type="file" multiple>`)
- **Drag-and-drop** — dragging files over the modal shows a drop zone overlay (semi-transparent blue tint + "drop files to upload" text centered). Dropping triggers upload to current directory.
- **Progress** — each uploading file gets a temporary row at the top of the file list. Row shows filename + animated progress bar (width 0→100%). On completion: directory re-fetches, row becomes a normal file entry. On error: row shows red background + error message, auto-removes after 10 seconds.
- Multiple files upload simultaneously, each with its own progress row.

### Download

- **Single file** — hover `[↓]` button triggers download. Progress bar fills the row background. On completion: browser's native save dialog (blob download with correct filename).
- **Bulk download** — footer download button with multiple files selected. Downloads each file sequentially. Each row shows progress as it downloads.
- No zip packaging — individual files download one at a time.

### Transfer cancellation

No explicit cancel button. Closing the modal during an active transfer triggers the confirmation prompt ("transfers in progress — close anyway?"). If confirmed, in-flight transfers are aborted in `onBeforeClose()`.

## Delete

### API endpoint (new)

`POST /api/devices/files/delete`
- Body: `{ udid: string, paths: string[] }`
- Server runs `adb -s {udid} shell rm -rf "{path}"` for each path
- Returns: `{ success: boolean, errors?: { path: string, error: string }[] }`
- Bulk-capable: one request deletes multiple files/directories

### UX

- **Single file/directory** — hover `[×]` button triggers confirmation: "delete {filename}?"
- **Bulk delete** — footer delete button triggers confirmation: "delete {n} items?"
- Confirmation is always required (no recycle bin on ADB devices — `rm` is permanent)
- After successful delete: directory re-fetches to update the listing
- Failed deletes: 10-second error notification (consistent with app error timing)

## SVG File Type Icons

Six icons, inline SVGs, themed to match the app:

| Icon | Color | Extensions |
|------|-------|------------|
| Folder | `#5b9aff` (app blue) | Directories |
| File | `rgba(255,255,255,0.5)` (neutral) | Unknown/generic |
| Image | `#4ade80` (green) | .jpg, .jpeg, .png, .gif, .bmp, .webp, .svg |
| Video | `#f97316` (orange) | .mp4, .mkv, .avi, .mov, .webm, .3gp |
| Audio | `#c084fc` (purple) | .mp3, .ogg, .flac, .aac, .wav, .m4a, .opus |
| Text | `rgba(255,255,255,0.5)` (neutral) | .txt, .md, .json, .xml, .yaml, .yml, .log, .conf, .sh, .py, .js, .ts, .html, .css, .csv |

- SVGs use Material Design style (24x24 viewBox, scales to `--file-icon-size`)
- Rendered as inline SVGs (inherit theme colors via `currentColor`)
- `getFileIcon(filename)` utility function: extension map → icon type
- Symlinks: target type icon + small arrow overlay (bottom-left)

## File Layout

### New files

- `src/app/googDevice/client/ListFilesModal.ts` — Modal subclass, file browser UI
- `src/app/googDevice/client/FileIconUtils.ts` — SVG icon registry + extension → icon mapping
- `src/style/listfiles.css` — file browser styles (glassmorphism theme, sortable headers, progress bars, etc.)

### Modified files

- `src/app/googDevice/client/DeviceTracker.ts` — intercept "list files" link → ListFilesModal
- `src/app/googDevice/client/FileListingClient.ts` — extract protocol/data logic into reusable service, or refactor to accept a container element
- `src/server/goog-device/mw/FileListing.ts` — add DELETE message handler
- `src/server/goog-device/AdbUtils.ts` — add `deleteFile(udid, paths)` method
- `src/style/modal.css` — add `dialog.list-files-modal` sizing rules
- Server routes — add `POST /api/devices/files/delete` endpoint

### Deleted after conversion

- `src/style/filelisting.css` — replaced by `listfiles.css`

### Not modified

- `src/app/ui/Modal.ts` — base class unchanged
- Other modals — unrelated
- Existing file protocol messages (LIST, RECV, SEND, STAT) — unchanged
