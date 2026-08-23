# Device Labels

User-assigned names for devices that persist across sessions, disconnects, and restarts.

## Problem

All device cards show hardware identifiers (model name, IP:port). With multiple devices of the same model (e.g., two Google TV Streamers), there's no way to tell them apart at a glance without memorizing IP addresses.

## Solution

A label system that lets users name devices. Labels are keyed by hardware serial number and stored in a JSON file on disk. Labels appear in connected device cards and can be set from either the scan flow or inline on the card itself.

## Data Storage

**File:** `device-labels.json` in the project root (next to `start.cmd`).

```json
{
  "49241HFAG07SUG": "Living Room TV",
  "51181HFAG0G1UZ": "Bedroom TV",
  "47121FDAQ000WC": "Jamie's Pixel 9"
}
```

**`DeviceLabelStore`** (`src/server/DeviceLabelStore.ts`):
- Singleton. Reads file on first access, caches in memory.
- `get(serial): string | undefined`
- `set(serial, label): void` -- writes to disk immediately.
- `delete(serial): void` -- writes to disk immediately.
- `getAll(): Record<string, string>`
- Sync writes (`fs.writeFileSync`). Label changes are infrequent -- no need for async.
- If the file doesn't exist on first read, starts with an empty map.

## Device Identification

**Hardware serial** (`ro.serialno`) is the stable key. It never changes across reboots, IP changes, or reconnects.

**For connected devices:** Add `ro.serialno` to the `Properties` array in `src/server/goog-device/Properties.ts` and to the `GoogDeviceDescriptor` type. It flows to the browser automatically via the existing property fetch + WebSocket broadcast pipeline.

**For scan results (mDNS):** Parse the serial from the mDNS service name:
- `adb-49241HFAG07SUG` (plain ADB) -> `49241HFAG07SUG`
- `adb-47121FDAQ000WC-7vmR8a` (TLS connect) -> `47121FDAQ000WC`

Helper function `parseSerialFromMdnsName(name: string): string`:
- Strip `adb-` prefix.
- For `_adb-tls-connect` names: the TLS instance suffix is always the last `-segment` and is 6-8 alphanumeric characters. Strip it.
- For plain `_adb._tcp` names: no suffix to strip.
- The function receives both the name and service type so it can decide whether to strip.

## API Endpoints

### GET /api/devices/labels

Returns all labels.

**Response:** `{ "49241HFAG07SUG": "Living Room TV", ... }`

### PUT /api/devices/labels

Set or update a label.

**Request body:** `{ "serial": "49241HFAG07SUG", "label": "Living Room TV" }`

**Response:** `{ "success": true }`

If label is empty string, deletes the label for that serial.

### POST /api/devices/scan (enhanced)

Response now includes a `serial` field on each device, parsed from the mDNS name. Also includes `label` if one exists in the store.

```json
[
  {
    "name": "adb-49241HFAG07SUG",
    "service": "_adb._tcp",
    "address": "192.168.86.43",
    "port": 5555,
    "serial": "49241HFAG07SUG",
    "label": "Living Room TV"
  }
]
```

### POST /api/devices/connect (enhanced)

Accepts optional `serial` and `label` fields. If both are present and label is non-empty, saves the label before connecting.

**Request body:** `{ "address": "192.168.86.43:5555", "serial": "49241HFAG07SUG", "label": "Living Room TV" }`

## Connected Device Cards

New first row in the device info table:

```
| Device Name: | Living Room TV                    [pencil] |
| Model:       | Google TV Streamer                          |
| Device ID:   | 192.168.86.43:5555                          |
| Android:     | 14                                          |
| SDK:         | 34                                          |
```

- **Column 1:** "Device Name:" styled with `device-label` class, matching existing label rows.
- **Column 2:** The label text. Pencil icon (small SVG) floated to the right edge of the cell.
- **Unlabeled devices:** Show "Unnamed Device" in muted/italic style. Same pencil icon.
- **Pencil always visible** -- works for both naming and renaming.

### Inline Edit Flow

1. User clicks pencil icon.
2. Label text replaced with a text input (pre-filled with current label, or empty for unnamed).
3. Pencil icon replaced with a checkmark icon.
4. **Save:** Press Enter or click checkmark. Calls `PUT /api/devices/labels`. Input reverts to label text. Pencil returns.
5. **Cancel:** Press Escape. Input reverts to previous label text. No API call.
6. The `serial` for the API call comes from `ro.serialno` in the device descriptor.

## Network Discovery (Scan) Cards

Each scan result card:

```
[mDNS name]  [address:port]
[Name this device: _______________]  [Connect]
```

- Text input with placeholder "Name this device..." -- **optional**, not required.
- If the device already has a label in the store (reconnecting a known device), the input is pre-filled.
- Connect works with or without a name.
- On connect: if the input has text, the label is sent with the connect request and saved server-side.

## Data Flow

```
Scan -> mDNS name -> parseSerial -> server enriches with serial + existing label
Browser renders scan card with optional name input
User optionally types label -> Connect -> POST /api/devices/connect { address, serial, label }
Server saves label (if provided) -> connects device
Device appears in Connected Devices -> ro.serialno in descriptor -> label looked up -> displayed
User clicks pencil on any card -> inline edit -> PUT /api/devices/labels -> saved to disk
```

## Files to Create

| File | Purpose |
|------|---------|
| `src/server/DeviceLabelStore.ts` | Label persistence (read/write JSON file) |

## Files to Modify

| File | Change |
|------|--------|
| `src/types/GoogDeviceDescriptor.d.ts` | Add `ro.serialno` field |
| `src/server/goog-device/Properties.ts` | Add `ro.serialno` to properties array |
| `src/server/goog-device/Device.ts` | Initialize `ro.serialno` in descriptor |
| `src/server/api/DeviceDiscoveryApi.ts` | Add label endpoints, enhance scan/connect |
| `src/server/AdbClient.ts` | Add `parseSerialFromMdnsName()` helper |
| `src/app/client/NetworkDiscoveryPanel.ts` | Add optional name input to scan cards |
| `src/app/googDevice/client/DeviceTracker.ts` | Add Device Name row with pencil + inline edit |
| `src/style/app.css` | Styles for pencil icon, inline edit, unnamed state |

## Out of Scope

- Bulk label import/export
- Label validation beyond non-empty string
- Label display in embed mode (no device cards in embed)
- Label search/filter
