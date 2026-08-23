# Network Scan — Port 5555 Fallback — Design Spec

**Date:** 2026-04-19
**Project:** ws-scrcpy-web
**Status:** Design approved, ready for implementation plan

## Goal

Find older Android devices on the LAN that don't advertise `_adb._tcp` / `_adb-tls-connect._tcp` via mDNS. These devices (pre-Android-11, TVs with mDNS disabled, phones where the user disabled it) are reachable via a plain TCP connection to port 5555 but invisible to today's mDNS-only scanner.

Replace the current `POST /api/devices/scan` one-shot with a configurable, streaming scan that runs mDNS discovery and a TCP-5555 subnet sweep in parallel, confirms each TCP hit with `adb connect`, and streams results into the existing Available Network Devices card.

## Why

This is the last meaningful gap in ws-scrcpy-web's device discovery. Users with older TVs or tablets have to type the IP manually every time — the "manually add" button exists precisely because discovery was incomplete. Sweeping port 5555 closes that gap with zero user effort on the common path.

This also keeps parity with the Control Menu project, which has the same TODO pending. Once this design lands here, the same shape ports over there.

## Non-goals

- **No raw ADB handshake implementation.** We confirm hits by shelling out to `adb connect` / `adb disconnect`, not by re-implementing the ADB protocol.
- **No paired / RSA-key handling.** If a device requires pairing (Android 11+ wireless debugging), `adb connect` will fail on an unpaired device and the hit will be dropped. These users are served by the existing mDNS flow.
- **No ping / ICMP pre-probe.** Raw ICMP needs admin on Windows; shelling to `ping` adds OS-specific parsing with marginal benefit. We go straight to TCP connect.
- **No ARP-table reading.** Evaluated and rejected — ARP is stale-prone and requires OS-specific output parsing for partial coverage.
- **No IPv6 support.** Port 5555 ADB is IPv4-only in practice on Android.
- **No rate-limiting or IDS-evasion.** We're a self-hosted LAN tool, not a pentest framework. Users get one honest warning about security scanners and then we scan normally.
- **No multi-tenant scan state.** One scan at a time per server. A second browser opening `/ws-scan` while a scan is running sees the in-progress scan's stream, doesn't start a new one.

## Summary of design decisions

| Decision | Choice |
|---|---|
| Subnet cap | No cap; warning modal if total host count > 2,048 (/21) |
| Results rendering | Dialog closes on scan start; progress chip in existing panel |
| Additional-subnets input | CIDR + bare IP + IP range; localStorage persistence |
| Cancel semantics | Stop enqueueing, let in-flight probes drain; chip shows "Finishing active scans…" |
| Gateway detection | Try default gateway → fall back to interface /24 sweep → fall back to manual-entry-only |
| Streaming transport | WebSocket (`/ws-scan`) |
| Subnet cheat sheet | Static HTML in `public/help/subnets.html`, written fresh from RFC/textbook knowledge |
| Adb confirmation | `adb connect` → `adb disconnect` → list in Available Network Devices panel; user clicks Connect to re-engage |
| Server architecture | New `NetworkScanner` class + `ScanMw` WS middleware |
| Result dedupe | Dedupe by `IP:port`; mDNS metadata wins when both sources hit |
| Already-connected filter | Devices present in `adb devices` are omitted from hit stream |

## End-to-end flow

```
User clicks "scan network"
  → Primary dialog opens (explanation + red warning + subnet list + buttons)
    → User may click "add subnet" → secondary modal for CIDR/IP/range entry (localStorage)
    → User clicks "start scan"
      → Host count computed across gateway subnet + additional subnets
        → If > 2,048: large-subnet confirmation modal (breakdown + time estimate)
          → "continue scan" proceeds; "cancel" returns to primary dialog
      → Primary dialog closes
      → Browser opens WS to /ws-scan, sends {type: 'scan.start', subnets: [...]}

Server (NetworkScanner)
  → Track 1 (mDNS): adb mdns services → filter → emit scan.hit(source='mdns')
  → Track 2 (TCP): expand subnets to host list → bounded pool (64 concurrent)
    → TCP connect IP:5555, 300ms timeout
      → On connect success: adb connect IP:5555 (3s timeout)
        → If "connected": adb disconnect, emit scan.hit(source='tcp')
    → Every 10 hosts: emit scan.progress(checked, total)
  → Filter: skip addresses already in `adb devices` output

Client (NetworkDiscoveryPanel)
  → Renders progress chip "Scanning network · 42 / 254 · Cancel"
  → Each scan.hit: dedupe by IP:port, render/merge card in Available Network Devices
  → User clicks Cancel in chip → WS send {type: 'scan.cancel'}
    → Server stops enqueueing; in-flight probes drain
    → Chip shows "Finishing active scans…" (Cancel hidden)
    → Server sends scan.cancelled when drain complete
    → Chip shows "Scan cancelled · N devices found", auto-hide 10s
  → Normal completion: server sends scan.complete
    → Chip shows "Scan complete · N devices found", auto-hide 5s
  → User clicks Connect on a card: existing POST /api/devices/connect (unchanged)
```

## UI components

### Primary dialog (`ScanNetworkModal`)

Native `<dialog>` extending the existing `Modal` base class (per `project_dialog_migration`). Contents, top to bottom:

1. Heading: **Scan Network for Devices**.
2. Explainer paragraph: "This scans your local network for Android devices with wireless debugging enabled. It checks mDNS broadcasts (modern devices) and probes port 5555 on each host in the selected subnets (older devices)."
3. **Red warning box** above the subnet list:
   > ⚠ Scanning sends connection attempts to every host on the selected subnet(s). On managed or corporate networks this may trigger intrusion-detection alerts. Only scan networks you own or administer.
4. **Subnet list** — rendered as rows:
   - Row 1 (always present if detected): `192.168.86.0/24 — 254 hosts (detected gateway subnet)` — no remove button
   - Row 2..N (if user added any): `10.0.0.0/20 — 4,094 hosts  [×]` — × removes from localStorage
   - If gateway detection failed: yellow note "Couldn't detect your gateway subnet. Add at least one subnet below to scan."
5. **Add subnet** button — opens secondary modal.
6. "New to CIDR? See the [subnet cheat sheet](help/subnets.html)" (`target="_blank"`, `rel="noopener"`).
7. Bottom action row: `[cancel]  [start scan]` — `start scan` disabled if total host count is 0.

Behavior:
- Dialog is scroll-locked (per `feedback_modal_scroll_lock`).
- ESC closes via native dialog behavior.
- "start scan" click: compute total host count across all rows; if > 2,048, open large-subnet confirmation modal (see below); otherwise proceed directly to scan start.

### Additional-subnets modal (`AddSubnetModal`)

Modal-on-modal, opened from primary dialog's "add subnet" button. Contents:

1. Heading: **Add Subnet to Scan**.
2. Input field: `192.168.2.0/24 or 192.168.2.5 or 192.168.2.10-50`.
3. Live validation below the input:
   - Empty → no message
   - Valid → green "✓ CIDR, 254 hosts" / "✓ single host" / "✓ range, 41 hosts"
   - Invalid → red with specific reason; longer explanations link to the [subnet cheat sheet](help/subnets.html) in a new tab so the user can learn on the spot (see parser section for exact wording)
4. Bottom action row: `[cancel]  [add]` — `add` disabled if input is empty or invalid.

On add:
- Append to `localStorage['ws-scrcpy-web:scan-subnets']` (JSON array of raw strings — we store what the user typed, parse on load).
- Close this modal; primary dialog refreshes its subnet list.

### Large-subnet confirmation modal (`LargeSubnetWarningModal`)

Modal-on-modal, fires from primary dialog's "start scan" when total host count > 2,048. Contents:

1. Heading: **Large Scan — Confirm**.
2. Paragraph:
   > The scan covers **{N} hosts** across **{M} subnet(s)**. At roughly 30 seconds per 1,000 hosts, this will take about **{time}**.
3. Per-subnet breakdown list:
   - `192.168.0.0/20 — 4,094 hosts (detected gateway subnet)`
   - `10.0.0.0/24 — 254 hosts (manually added)`
4. "To narrow the scan, cancel and edit subnets. Otherwise continue."
5. Bottom action row: `[cancel]  [continue scan]`.

Time formula: `Math.round(totalHosts / 1000 * 30)` seconds. Display:
- If seconds < 60 → "about X seconds"
- Else compute `minutes = Math.round(seconds / 60)`. If minutes === 1 → "about 1 minute"; otherwise → "about N minutes".

On cancel: close this modal, return to primary dialog (it stays open underneath).
On continue: proceed to scan start (close both modals, open WS, etc.).

### Progress chip (`ScanProgressChip`)

Pinned element inside the Available Network Devices card header area (not a modal — keeps the rest of the UI interactive per Q2). Lives as its own component, appended/removed from the panel on scan lifecycle events.

States:

| State | Content | Interaction |
|---|---|---|
| Scanning | `Scanning network · 42 / 254 · [Cancel]` | Cancel sends `scan.cancel` |
| Draining | `Finishing active scans…` | Cancel hidden; × dismiss hidden |
| Complete | `Scan complete · 3 devices found  [×]` | × dismisses; auto-hide 5s |
| Cancelled | `Scan cancelled · 3 devices found  [×]` | × dismisses; auto-hide 10s |

Progress counter reflects TCP-track progress only (mDNS is fire-and-forget). Device count reflects combined unique hits across both tracks.

During Scanning and Draining, the primary dialog's "start scan" is disabled if re-opened — single-scan-at-a-time per Q10.2.

### Cheat sheet page (`public/help/subnets.html`)

Standalone HTML + inline CSS. No framework. Written fresh from public/textbook knowledge — no third-party content copied. Attribution line at the bottom: "Written for ws-scrcpy-web. References: RFC 1918 (Private IPv4 ranges), RFC 4632 (CIDR notation)."

Content sections (in order):
1. **What is a subnet?** — paragraph: IP addresses, network/host split.
2. **What is CIDR notation?** — `192.168.1.0/24` means "first 24 bits are network, last 8 are host." Table of prefix → host count → mask (from /16 to /32).
3. **Private IP ranges (RFC 1918)** — `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`. Short examples.
4. **What does my home router use?** — typical ISPs default to `192.168.0.0/24` or `192.168.1.0/24`. How to check (ipconfig/ifconfig).
5. **How to enter subnets in ws-scrcpy-web** — accepted formats with examples, what the scan does.
6. **Back to app** link.

Styling: dark background, light text, monospace for IPs/masks, no dependencies. Target file size < 15 KB.

## Subnet detection

Implemented in `src/server/network/SubnetDetector.ts`. Single public method `detect(): Promise<DetectedSubnet | null>` returns the gateway subnet or null if all fallbacks fail.

Fallback cascade (Q5 answer C):

1. **Gateway-based** (primary). On Windows: `route print -4` parse for default route (0.0.0.0 destination), get interface index, cross-reference with `os.networkInterfaces()` to get that interface's IP + netmask → compute CIDR. On Linux: `ip route show default` → `ip -o -4 addr show dev <iface>` → parse CIDR directly. Wrap both in try/catch; any parse failure falls through.
2. **Interface-based** (fallback). Enumerate `os.networkInterfaces()`. For each entry where `family === 'IPv4'`, `internal === false`, and address is in an RFC 1918 range, include it. If multiple, prefer the one with smallest netmask (largest subnet = likely the "main" LAN).
3. **None** (final fallback). Return null. Client renders the "couldn't detect your gateway" note and disables the scan button until the user adds a manual subnet.

`DetectedSubnet` shape:
```ts
interface DetectedSubnet {
    cidr: string;         // e.g. '192.168.86.0/24'
    hostCount: number;    // usable host count (2^(32-prefix) - 2, or 1 for /32)
    source: 'gateway' | 'interface';
    interfaceName?: string;  // populated when source is 'interface'
}
```

## Subnet parsing (Q3a answer C)

Implemented in `src/server/network/SubnetParser.ts`. Single public function `parseSubnetInput(input: string): ParsedSubnet | ParseError`.

Accepted formats:

1. **CIDR**: `192.168.1.0/24`, `10.0.0.0/16`, `192.168.1.5/32`. Prefix must be 16-32 (anything shorter would sweep too many hosts; /32 is legal and means single host).
2. **Bare IP**: `192.168.1.5`. Treated as `/32`.
3. **IP range**: `192.168.1.10-192.168.1.50` or the shorthand `192.168.1.10-50` (end is same subnet, just last octet). Start must be ≤ end. Range expands to the inclusive list.

`ParsedSubnet` shape:
```ts
interface ParsedSubnet {
    raw: string;              // as user typed
    normalized: string;       // '192.168.1.0/24' or '192.168.1.5/32' or '192.168.1.10-192.168.1.50'
    hostCount: number;
    hosts(): Generator<string>;  // lazy IP enumeration for the sweep
}
```

`ParseError` has a `reason: string` for display in the live-validation area of `AddSubnetModal`.

Validation rules:
- Octets 0–255.
- CIDR prefix 16–32. Reject `/0` through `/15` with: *"Subnet too large — maximum prefix is /16 (65,534 hosts). If you need to cover more than that, add multiple /16 entries (one per subnet) using the 'add subnet' button. See the [subnet cheat sheet](help/subnets.html) for help."*
- Range: start and end must differ only in the last octet (same `/24`) and start ≤ end. Reject cross-octet ranges with: *"Range must stay within the same /24 — that's a block of up to 254 hosts where only the last number changes (e.g. 192.168.1.10-50). For anything larger, switch to CIDR notation like 192.168.1.0/24. See the [subnet cheat sheet](help/subnets.html) if you're unsure."*
- Empty input, whitespace-only, garbage → "Unrecognized format. Try CIDR (192.168.1.0/24), a single IP (192.168.1.5), or a range (192.168.1.10-50). See the [subnet cheat sheet](help/subnets.html)."

## Server architecture

### `NetworkScanner` class (`src/server/network/NetworkScanner.ts`)

Owns scan orchestration for the single active scan. Singleton (one active scan at a time per server).

Public API:
```ts
class NetworkScanner {
    static getInstance(): NetworkScanner;
    isScanning(): boolean;
    async start(subnets: ParsedSubnet[], ws: WebSocket): Promise<void>;
    cancel(): void;
    attachSpectator(ws: WebSocket): void;  // for a second browser joining the in-progress scan
}
```

Internal state machine: `idle → scanning → draining → idle`. State transitions are explicit; callers see state via `isScanning()`.

Implementation sketch of `start()`:

```
1. Compute full host list: flat-map subnets' hosts() generators (lazy).
2. Fetch already-connected list once: adb devices → Set<address>.
3. Emit scan.started with totals.
4. Track A (mDNS, async):
   - adb mdns services → filter
   - For each hit: skip if in already-connected set; emit scan.hit(source='mdns').
5. Track B (TCP, async with bounded pool):
   - Pool of size 64 consumes host stream.
   - Per host:
     a. Skip if `host:5555` in already-connected set.
     b. TCP connect to host:5555, 300ms timeout.
        - On failure/timeout: release slot.
        - On success: close socket, proceed to c.
     c. adb connect host:5555 (3s timeout via Promise.race).
        - If output contains 'connected':
          - adb disconnect host:5555 (fire and forget, 2s timeout).
          - Emit scan.hit(source='tcp', address=host:5555).
        - Otherwise: release slot.
     d. Every 10 hosts completed: emit scan.progress.
6. When both tracks finish (or drain completes after cancel):
   - Emit scan.complete (or scan.cancelled if cancelled).
   - Transition to idle.
```

Cancellation is cooperative. `cancel()` sets an internal flag. The pool reads the flag before dequeueing the next host; reading `true` stops enqueueing. In-flight probes continue naturally (per Q4 answer B — graceful drain). When the pool empties post-cancel, state transitions to `draining` then `idle`. Drain emits `scan.draining` so the chip can update, then `scan.cancelled` at the end.

Timeouts are enforced with `AbortController` on the TCP `net.Socket` (for probes) and `Promise.race` with `setTimeout` for the `adb connect` shell-out (since child_process doesn't integrate with AbortController cleanly on Windows).

### `ScanMw` middleware (`src/server/mw/ScanMw.ts`)

Extends the existing `Mw` base class (same pattern as the other WS middlewares). Registers on URL prefix `/ws-scan`.

On connect:
- If `NetworkScanner.isScanning()` → call `attachSpectator(ws)` and send an immediate `scan.started` snapshot of current progress.
- Otherwise → wait for client's first message.

On message:
- `scan.start` → parse payload `{subnets: string[]}`, run through `SubnetParser.parseSubnetInput()`, reject the whole message with `scan.error` if any are invalid. Call `NetworkScanner.start(parsed, ws)`.
- `scan.cancel` → call `NetworkScanner.cancel()`. No-op if not scanning.

On disconnect: client disconnect does NOT cancel the scan. Scan runs to completion server-side. (Matches Q10.2's single-scan invariant — if we cancelled on disconnect, a page refresh would orphan a scan.)

### `DeviceDiscoveryApi` changes

The existing `POST /api/devices/scan` endpoint stays, but its implementation is reduced to an mDNS-only compatibility shim (same behavior as today) for any external callers. The primary path is the new WS endpoint. We keep the REST endpoint to avoid breaking the embed API or any third-party integrations.

No other REST endpoints change. `connect`, `disconnect`, `screen-state`, `sleep-wake`, `labels`, `files/delete` all remain.

## WebSocket protocol

All messages are JSON, `type`-tagged. Client → server and server → client.

### Client → server

```ts
// Start a scan
{ type: 'scan.start', subnets: string[] }   // raw user strings

// Cancel in-progress scan
{ type: 'scan.cancel' }
```

### Server → client

```ts
// Initial ack after scan.start (or on spectator attach)
{
    type: 'scan.started',
    totalHosts: number,
    totalSubnets: number,
    startedAt: number  // epoch ms
}

// Parse rejection (sent in response to scan.start with invalid subnets)
{
    type: 'scan.error',
    reason: string,
    details?: { subnet: string, error: string }[]
}

// Periodic progress
{
    type: 'scan.progress',
    checked: number,  // TCP probes completed
    total: number,    // total TCP hosts
    foundSoFar: number
}

// Each discovered device
{
    type: 'scan.hit',
    source: 'mdns' | 'tcp',
    address: string,    // IP:port
    serial: string,     // from mDNS name, or from `adb connect` output
    name: string,       // mDNS service name, or address for TCP
    label: string       // from DeviceLabelStore if known, else ''
}

// User cancelled, server stopped enqueueing, in-flight probes draining
{ type: 'scan.draining' }

// Scan finished normally
{ type: 'scan.complete', found: number }

// Scan finished after cancel (all in-flight drained)
{ type: 'scan.cancelled', found: number }
```

Ordering: `scan.started` → (`scan.progress` | `scan.hit`)* → (`scan.draining`? → `scan.cancelled`) | `scan.complete`. Exactly one terminal message.

## Dedupe & filter rules

- **Dedupe key**: `IP:port`. Both server and client dedupe on this key.
- **Server-side dedupe** (authoritative): `NetworkScanner` maintains an `emitted: Set<address>` for the active scan. The first hit for a given address wins and is emitted; subsequent hits for the same address (typically a later TCP confirm arriving after an earlier mDNS hit) are silently dropped. This ensures `scan.progress.foundSoFar` and the terminal `found` count reflect unique devices. In practice mDNS returns within ~500ms so it usually wins the race; if TCP wins first, the mDNS follow-up is dropped but the device is still visible with address-only metadata.
- **Client-side dedupe** (defense in depth): `NetworkDiscoveryPanel` keeps a `Map<address, Card>` for the scan session. If a duplicate hit somehow arrives, the client merges fields — prefer non-empty values from the newer hit; prefer `source='mdns'` serial/name over `source='tcp'` metadata; label always wins if already set.
- **Already-connected filter** (server-side): computed once at scan start via `adb devices` output. Any address in that set is skipped by both tracks before emission.
- **Cross-scan persistence**: Cards from one scan stay visible until the next scan starts (or the user clicks Connect on them, which removes them via existing behavior). A new `scan.start` clears the Available Network Devices card as today.

## Error handling

- **Gateway detection failure**: logged server-side, primary dialog shows yellow notice, scan button disabled until user adds subnet.
- **Subnet parse failure**: live validation in AddSubnetModal catches it before adding. Server also re-validates on `scan.start` (defense in depth) and rejects with `scan.error` if any slip through.
- **WS disconnect during scan**: server continues the scan to completion. Client reconnect attaches as spectator, receives current progress.
- **`adb connect` timeout or error**: probe is dropped (no hit emitted). Not logged at WARN to avoid noise — expected for any non-ADB service on 5555.
- **TCP probe errors other than ECONNREFUSED/ETIMEDOUT**: logged at DEBUG, probe dropped.
- **mDNS track failure**: logged at WARN, track ends early, TCP track continues independently.
- **Subnet larger than /16**: parser rejects with the canonical friendly message from the "Subnet parsing" section above. Even with the warning dialog, we refuse prefixes shorter than /16 (65,534 hosts) to avoid catastrophic misuse — that's ~33 minutes of scanning. Users who really need a larger range can split it into multiple /16s.

## Testing

### Unit tests

- `SubnetParser.test.ts` — exhaustive: valid CIDR/IP/range inputs, each error path, edge cases (`0.0.0.0/32`, `255.255.255.255`, ranges with start==end, shorthand ranges).
- `SubnetDetector.test.ts` — mock `os.networkInterfaces()` + mock child_process for `route print` / `ip route`. Test each fallback level triggers correctly.
- `NetworkScanner.test.ts` — mock `AdbClient` + mock TCP probe function (inject a `tcpProbe` dependency). Assert correct scan.hit ordering, cancel drains, timeouts respected.

### Integration tests

- `scanMw.test.ts` — boots a test WS server with `ScanMw`, drives a mock client through scan.start → scan.progress → scan.complete. Verifies dedupe behavior across mDNS+TCP hits for the same address.

### Manual test checklist (added to manual test list, item 4 of main TODO)

- [ ] Primary dialog opens; gateway subnet shown with host count.
- [ ] Add subnet modal accepts CIDR, IP, range; rejects garbage with specific reason.
- [ ] Additional subnets persist across page reload.
- [ ] Large-subnet warning fires at > 2,048 hosts, not at 2,048.
- [ ] Progress chip counter updates every ~10 hosts.
- [ ] Cancel triggers drain state, then cancelled state.
- [ ] Completed state auto-hides at 5s; cancelled at 10s.
- [ ] Cheat sheet link opens in new tab, renders cleanly.
- [ ] Gateway detection fallback: disable wifi, reload, verify dialog shows "couldn't detect" notice.
- [ ] mDNS and TCP hits for the same device dedupe; mDNS metadata wins.
- [ ] Device already connected (in `adb devices`) is skipped.

## Open questions / followups

1. **Control Menu parity — full scanner audit required before porting.** After this ships in ws-scrcpy-web, port the same design to Control Menu's scanner. **Do not pattern-match the scanner code from here to there.** Control Menu's scanner has behaviors that ws-scrcpy-web does not:
   - **Database-backed state.** Control Menu persists device/scan state to its SQL database; the scanner reads and writes DB records as part of its flow (device registration, scan history, per-device metadata).
   - **Additional adb-aware procedures.** Control Menu has adb functions woven into the scanner that aren't present in ws-scrcpy-web.
   - The port requires a **full audit of Control Menu's existing scanner** — its DB schema touchpoints, its adb procedures, and any side effects — before this design's patterns are applied. The UX pattern (dialog + chip + WS streaming + cheat sheet) ports cleanly; the server-side orchestrator (`NetworkScanner`) does not port verbatim because it has no DB layer and would drop Control Menu's DB-backed behavior if copied blindly.
2. **ARP+5555 item on the TODO** — this spec fulfils item 5 of the ws-scrcpy-web TODO list. Update `project_wsscrcpy_todo.md` on ship.
3. **Tuning knobs** — concurrency (64), TCP timeout (300ms), adb-connect timeout (3s), progress-emit interval (every 10 hosts) are all educated guesses. Expose as `Config` fields so they can be tuned per install without a rebuild.
