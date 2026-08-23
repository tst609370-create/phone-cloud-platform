# Network Scan — Port 5555 Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a streaming network scanner that discovers older Android devices via port-5555 sweeps alongside the existing mDNS scan, with a configurable-subnets dialog, progress chip, localStorage-persisted user subnets, and an in-app subnet cheat sheet.

**Architecture:** New `NetworkScanner` singleton (server) orchestrates a bounded-concurrency TCP probe pool in parallel with mDNS discovery, confirms each TCP hit via `adb connect`/`adb disconnect`, and streams `scan.hit` / `scan.progress` / terminal messages over a new `/ws-scan` WebSocket middleware. Client-side, the existing `scan network` button opens a new `ScanNetworkModal` (extending the existing `Modal` base class) that lets the user review/edit subnets, triggers a `LargeSubnetWarningModal` when total host count > 2,048, closes on scan start, and surfaces a `ScanProgressChip` in the existing `NetworkDiscoveryPanel` for the duration of the scan.

**Tech Stack:** TypeScript 6, Node ≥ 24, vitest, ws 8.18, native `<dialog>` + `Modal` base class, webpack 5, biome linting.

**Spec reference:** `docs/superpowers/specs/2026-04-19-network-scan-port-5555-design.md`

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/common/ScanMessage.ts` | TypeScript types for the WS message protocol — shared by client and server. |
| `src/common/SubnetParser.ts` | Parse user-typed subnet input: CIDR, bare IP, IP range. Returns `ParsedSubnet` with lazy host generator, or `ParseError` with friendly message. Lives in `common/` because both server and client need it (client for live validation in the add-subnet modal). Pure TS — no Node imports. |
| `src/server/network/SubnetDetector.ts` | Detect gateway subnet with three-level fallback (gateway → interface → null). Cross-platform (Windows/Linux). |
| `src/server/network/NetworkScanner.ts` | Singleton scan orchestrator: state machine, TCP probe pool, mDNS track, adb-confirm, dedupe, cancel drain, WS emit. |
| `src/server/mw/ScanMw.ts` | WebSocket middleware on `/ws-scan` path. Handles `scan.start`/`scan.cancel` messages, forwards to `NetworkScanner`, supports spectator attach. |
| `src/server/__tests__/subnetParser.test.ts` | vitest suite for SubnetParser. |
| `src/server/__tests__/subnetDetector.test.ts` | vitest suite for SubnetDetector. |
| `src/server/__tests__/networkScanner.test.ts` | vitest suite for NetworkScanner with injected fakes. |
| `src/server/__tests__/scanMw.test.ts` | Integration test for ScanMw over a real WS server. |
| `src/app/client/ScanNetworkModal.ts` | Primary dialog: explainer + red warning + subnet list + buttons. |
| `src/app/client/AddSubnetModal.ts` | Secondary modal: subnet input + live validation + add to localStorage. |
| `src/app/client/LargeSubnetWarningModal.ts` | Tertiary modal: shown when scan covers > 2,048 hosts. Shows breakdown + time estimate. |
| `src/app/client/ScanProgressChip.ts` | Inline progress component pinned in NetworkDiscoveryPanel header. Four states: scanning/draining/complete/cancelled. |
| `public/help/subnets.html` | Standalone HTML + inline CSS subnet cheat sheet. No framework. Self-contained. |

### Modified files

| Path | Change |
|---|---|
| `src/app/client/NetworkDiscoveryPanel.ts` | Rewire `scan network` button to open new modal; add WS client for streaming hits; mount/dismount `ScanProgressChip`; keep `manually add` flow unchanged. |
| `src/server/index.ts` | Register `ScanMw` in the `mwList`. |
| `CHANGELOG.md` | Add entry under Unreleased. |

### Files that do NOT change

- `src/server/api/DeviceDiscoveryApi.ts` — existing `POST /api/devices/scan` is already mDNS-only; it stays as the REST compat shim. No change required.
- `src/server/AdbClient.ts` — already exposes `connect`, `disconnect`, `mdnsServices`, `devices`. No change required.
- All other client panels, modals, and server modules.

---

## Task 1: Shared WS message types

**Files:**
- Create: `src/common/ScanMessage.ts`

- [ ] **Step 1: Create the message types file**

Create `src/common/ScanMessage.ts`:

```ts
// Client → server

export interface ScanStartMessage {
    type: 'scan.start';
    subnets: string[]; // raw user-typed strings
}

export interface ScanCancelMessage {
    type: 'scan.cancel';
}

export type ScanClientMessage = ScanStartMessage | ScanCancelMessage;

// Server → client

export interface ScanStartedMessage {
    type: 'scan.started';
    totalHosts: number;
    totalSubnets: number;
    startedAt: number; // epoch ms
}

export interface ScanErrorMessage {
    type: 'scan.error';
    reason: string;
    details?: { subnet: string; error: string }[];
}

export interface ScanProgressMessage {
    type: 'scan.progress';
    checked: number;
    total: number;
    foundSoFar: number;
}

export interface ScanHitMessage {
    type: 'scan.hit';
    source: 'mdns' | 'tcp';
    address: string; // 'IP:port'
    serial: string;
    name: string;
    label: string;
}

export interface ScanDrainingMessage {
    type: 'scan.draining';
}

export interface ScanCompleteMessage {
    type: 'scan.complete';
    found: number;
}

export interface ScanCancelledMessage {
    type: 'scan.cancelled';
    found: number;
}

export type ScanServerMessage =
    | ScanStartedMessage
    | ScanErrorMessage
    | ScanProgressMessage
    | ScanHitMessage
    | ScanDrainingMessage
    | ScanCompleteMessage
    | ScanCancelledMessage;

export const SCAN_WS_PATH = '/ws-scan';
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean exit, no new errors introduced.

- [ ] **Step 3: Commit**

```bash
git add src/common/ScanMessage.ts
git commit -m "feat(scan): shared WebSocket message types"
```

---

## Task 2: SubnetParser — CIDR, IP, range, validation

**Files:**
- Create: `src/common/SubnetParser.ts`
- Create: `src/server/__tests__/subnetParser.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/server/__tests__/subnetParser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSubnetInput } from '../../common/SubnetParser';

describe('parseSubnetInput — CIDR', () => {
    it('parses 192.168.1.0/24', () => {
        const r = parseSubnetInput('192.168.1.0/24');
        expect('reason' in r).toBe(false);
        if ('reason' in r) return;
        expect(r.normalized).toBe('192.168.1.0/24');
        expect(r.hostCount).toBe(254);
        const hosts = [...r.hosts()];
        expect(hosts[0]).toBe('192.168.1.1');
        expect(hosts.at(-1)).toBe('192.168.1.254');
        expect(hosts).toHaveLength(254);
    });

    it('parses 10.0.0.0/16', () => {
        const r = parseSubnetInput('10.0.0.0/16');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(65534);
        const first = r.hosts().next().value;
        expect(first).toBe('10.0.0.1');
    });

    it('parses /32 single-host', () => {
        const r = parseSubnetInput('192.168.1.5/32');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(1);
        expect([...r.hosts()]).toEqual(['192.168.1.5']);
    });

    it('rejects prefix < /16 with friendly message', () => {
        const r = parseSubnetInput('10.0.0.0/15');
        expect('reason' in r).toBe(true);
        if (!('reason' in r)) return;
        expect(r.reason).toMatch(/maximum prefix is \/16/);
        expect(r.reason).toMatch(/multiple \/16 entries/);
    });

    it('rejects prefix > /32', () => {
        const r = parseSubnetInput('192.168.1.0/33');
        expect('reason' in r).toBe(true);
    });

    it('rejects invalid octet', () => {
        const r = parseSubnetInput('192.168.1.300/24');
        expect('reason' in r).toBe(true);
    });
});

describe('parseSubnetInput — bare IP', () => {
    it('treats bare IP as /32', () => {
        const r = parseSubnetInput('192.168.1.5');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.normalized).toBe('192.168.1.5/32');
        expect(r.hostCount).toBe(1);
        expect([...r.hosts()]).toEqual(['192.168.1.5']);
    });
});

describe('parseSubnetInput — range', () => {
    it('parses long form range', () => {
        const r = parseSubnetInput('192.168.1.10-192.168.1.20');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(11);
        expect(r.normalized).toBe('192.168.1.10-192.168.1.20');
        expect([...r.hosts()]).toEqual([
            '192.168.1.10','192.168.1.11','192.168.1.12','192.168.1.13','192.168.1.14',
            '192.168.1.15','192.168.1.16','192.168.1.17','192.168.1.18','192.168.1.19','192.168.1.20',
        ]);
    });

    it('parses shorthand range', () => {
        const r = parseSubnetInput('192.168.1.10-20');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(11);
        expect(r.normalized).toBe('192.168.1.10-192.168.1.20');
    });

    it('allows start == end', () => {
        const r = parseSubnetInput('192.168.1.5-5');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(1);
    });

    it('rejects start > end with friendly message', () => {
        const r = parseSubnetInput('192.168.1.20-10');
        if (!('reason' in r)) throw new Error('expected error');
        expect(r.reason).toMatch(/start.*end/i);
    });

    it('rejects cross-/24 range with friendly message', () => {
        const r = parseSubnetInput('192.168.1.10-192.168.2.10');
        if (!('reason' in r)) throw new Error('expected error');
        expect(r.reason).toMatch(/same \/24/);
        expect(r.reason).toMatch(/CIDR/);
    });
});

describe('parseSubnetInput — errors', () => {
    it('returns unrecognized-format error for garbage', () => {
        const r = parseSubnetInput('not an ip');
        if (!('reason' in r)) throw new Error('expected error');
        expect(r.reason).toMatch(/Unrecognized format/);
    });

    it('returns unrecognized-format error for empty input', () => {
        const r = parseSubnetInput('');
        expect('reason' in r).toBe(true);
    });

    it('trims whitespace', () => {
        const r = parseSubnetInput('  192.168.1.0/24  ');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(254);
    });

    it('embeds cheat-sheet link in errors', () => {
        const r = parseSubnetInput('not an ip');
        if (!('reason' in r)) throw new Error('expected error');
        expect(r.reason).toMatch(/subnet cheat sheet/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/subnetParser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/common/SubnetParser.ts`:

```ts
const CHEAT_SHEET_NOTE = 'See the subnet cheat sheet at /help/subnets.html for help.';

export interface ParsedSubnet {
    raw: string;
    normalized: string;
    hostCount: number;
    hosts(): Generator<string>;
}

export interface ParseError {
    reason: string;
}

export function parseSubnetInput(input: string): ParsedSubnet | ParseError {
    const raw = input.trim();
    if (!raw) return unrecognized();

    // Try CIDR
    if (raw.includes('/')) return parseCidr(raw);

    // Try range
    if (raw.includes('-')) return parseRange(raw);

    // Try bare IP
    if (isValidIp(raw)) {
        return {
            raw,
            normalized: `${raw}/32`,
            hostCount: 1,
            *hosts() { yield raw; },
        };
    }

    return unrecognized();
}

function parseCidr(input: string): ParsedSubnet | ParseError {
    const [ipPart, prefixPart] = input.split('/');
    if (!ipPart || !prefixPart) return unrecognized();
    if (!isValidIp(ipPart)) return { reason: `Invalid IP address "${ipPart}". ${CHEAT_SHEET_NOTE}` };

    const prefix = Number.parseInt(prefixPart, 10);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
        return { reason: `Prefix must be between /16 and /32. ${CHEAT_SHEET_NOTE}` };
    }
    if (prefix < 16) {
        return {
            reason:
                'Subnet too large — maximum prefix is /16 (65,534 hosts). ' +
                'If you need to cover more than that, add multiple /16 entries ' +
                "(one per subnet) using the 'add subnet' button. " +
                CHEAT_SHEET_NOTE,
        };
    }
    if (prefix > 32) {
        return { reason: `Prefix must be between /16 and /32. ${CHEAT_SHEET_NOTE}` };
    }

    const ipInt = ipToInt(ipPart);
    const maskBits = 32 - prefix;
    const netmask = maskBits === 32 ? 0 : (0xffffffff << maskBits) >>> 0;
    const networkInt = (ipInt & netmask) >>> 0;
    const normalizedIp = intToIp(networkInt);
    const normalized = `${normalizedIp}/${prefix}`;

    const hostCount = prefix === 32 ? 1 : 2 ** maskBits - 2;
    // /31 is unusual (2 hosts) but legal — we allow it.
    const effectiveHostCount = prefix === 32 ? 1 : prefix === 31 ? 2 : hostCount;

    return {
        raw: input,
        normalized,
        hostCount: effectiveHostCount,
        *hosts() {
            if (prefix === 32) {
                yield normalizedIp;
                return;
            }
            // Iterate: network+1 .. broadcast-1 (standard usable range)
            // For /31 the two addresses both count as usable.
            const start = prefix === 31 ? networkInt : networkInt + 1;
            const end = prefix === 31 ? networkInt + 1 : networkInt + 2 ** maskBits - 2;
            for (let i = start; i <= end; i++) {
                yield intToIp(i >>> 0);
            }
        },
    };
}

function parseRange(input: string): ParsedSubnet | ParseError {
    const dashIdx = input.indexOf('-');
    const startStr = input.slice(0, dashIdx).trim();
    const endStr = input.slice(dashIdx + 1).trim();

    if (!isValidIp(startStr)) return { reason: `Invalid start IP "${startStr}". ${CHEAT_SHEET_NOTE}` };

    // Shorthand: "192.168.1.10-20"
    let endIp: string;
    if (isValidIp(endStr)) {
        endIp = endStr;
    } else if (/^\d{1,3}$/.test(endStr)) {
        const startParts = startStr.split('.');
        endIp = `${startParts[0]}.${startParts[1]}.${startParts[2]}.${endStr}`;
        if (!isValidIp(endIp)) return { reason: `Invalid end octet "${endStr}". ${CHEAT_SHEET_NOTE}` };
    } else {
        return { reason: `Invalid end of range "${endStr}". ${CHEAT_SHEET_NOTE}` };
    }

    const startParts = startStr.split('.');
    const endParts = endIp.split('.');
    // Same /24 check
    if (startParts[0] !== endParts[0] || startParts[1] !== endParts[1] || startParts[2] !== endParts[2]) {
        return {
            reason:
                "Range must stay within the same /24 — that's a block of up to 254 hosts " +
                'where only the last number changes (e.g. 192.168.1.10-50). ' +
                'For anything larger, switch to CIDR notation like 192.168.1.0/24. ' +
                CHEAT_SHEET_NOTE,
        };
    }

    const startInt = ipToInt(startStr);
    const endInt = ipToInt(endIp);
    if (startInt > endInt) {
        return { reason: `Range start must be ≤ end (got ${startStr} > ${endIp}). ${CHEAT_SHEET_NOTE}` };
    }

    const hostCount = endInt - startInt + 1;
    return {
        raw: input,
        normalized: `${startStr}-${endIp}`,
        hostCount,
        *hosts() {
            for (let i = startInt; i <= endInt; i++) {
                yield intToIp(i >>> 0);
            }
        },
    };
}

function unrecognized(): ParseError {
    return {
        reason:
            'Unrecognized format. Try CIDR (192.168.1.0/24), a single IP (192.168.1.5), ' +
            `or a range (192.168.1.10-50). ${CHEAT_SHEET_NOTE}`,
    };
}

function isValidIp(s: string): boolean {
    const parts = s.split('.');
    if (parts.length !== 4) return false;
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return false;
        const n = Number.parseInt(p, 10);
        if (n < 0 || n > 255) return false;
    }
    return true;
}

function ipToInt(ip: string): number {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function intToIp(n: number): string {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/__tests__/subnetParser.test.ts`
Expected: all tests PASS (19 tests).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no new warnings/errors in the two new files.

- [ ] **Step 6: Commit**

```bash
git add src/common/SubnetParser.ts src/server/__tests__/subnetParser.test.ts
git commit -m "feat(scan): subnet parser with CIDR, IP, and range support"
```

---

## Task 3: SubnetDetector — gateway → interface → null fallback

**Files:**
- Create: `src/server/network/SubnetDetector.ts`
- Create: `src/server/__tests__/subnetDetector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/subnetDetector.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type * as os from 'os';
import { detectSubnet, __internals } from '../network/SubnetDetector';

describe('SubnetDetector', () => {
    it('returns null when no interfaces and no gateway', async () => {
        const result = await detectSubnet({
            getInterfaces: () => ({}),
            runCommand: async () => { throw new Error('no route'); },
            platform: 'linux',
        });
        expect(result).toBeNull();
    });

    it('falls back to interface when gateway detection fails', async () => {
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            eth0: [{
                address: '192.168.86.50',
                netmask: '255.255.255.0',
                family: 'IPv4',
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: '192.168.86.50/24',
            }],
        };
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand: async () => { throw new Error('no gateway'); },
            platform: 'linux',
        });
        expect(result).not.toBeNull();
        expect(result?.cidr).toBe('192.168.86.0/24');
        expect(result?.source).toBe('interface');
        expect(result?.hostCount).toBe(254);
    });

    it('uses gateway detection on Linux (ip route)', async () => {
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            eth0: [{
                address: '192.168.1.42',
                netmask: '255.255.255.0',
                family: 'IPv4',
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: '192.168.1.42/24',
            }],
        };
        const runCommand = vi.fn(async (cmd: string) => {
            if (cmd.startsWith('ip route show default')) {
                return 'default via 192.168.1.1 dev eth0 proto dhcp metric 100';
            }
            if (cmd.startsWith('ip -o -4 addr show dev eth0')) {
                return '2: eth0    inet 192.168.1.42/24 brd 192.168.1.255 scope global eth0';
            }
            throw new Error(`unexpected: ${cmd}`);
        });
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand,
            platform: 'linux',
        });
        expect(result?.cidr).toBe('192.168.1.0/24');
        expect(result?.source).toBe('gateway');
    });

    it('skips internal and non-IPv4 interfaces in fallback', async () => {
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            lo: [{
                address: '127.0.0.1',
                netmask: '255.0.0.0',
                family: 'IPv4',
                mac: '00:00:00:00:00:00',
                internal: true,
                cidr: '127.0.0.1/8',
            }],
            eth0: [{
                address: 'fe80::1',
                netmask: 'ffff:ffff:ffff:ffff::',
                family: 'IPv6',
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: 'fe80::1/64',
                scopeid: 0,
            }],
        };
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand: async () => { throw new Error('no gateway'); },
            platform: 'linux',
        });
        expect(result).toBeNull();
    });

    it('prefers smallest netmask when multiple RFC1918 interfaces match', async () => {
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            eth0: [{
                address: '192.168.1.5',
                netmask: '255.255.255.0', // /24
                family: 'IPv4',
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: '192.168.1.5/24',
            }],
            eth1: [{
                address: '10.0.0.5',
                netmask: '255.255.0.0', // /16
                family: 'IPv4',
                mac: '11:22:33:44:55:66',
                internal: false,
                cidr: '10.0.0.5/16',
            }],
        };
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand: async () => { throw new Error('no gateway'); },
            platform: 'linux',
        });
        expect(result?.cidr).toBe('10.0.0.0/16');
    });
});

describe('SubnetDetector internals', () => {
    it('netmaskToPrefix handles common masks', () => {
        expect(__internals.netmaskToPrefix('255.255.255.0')).toBe(24);
        expect(__internals.netmaskToPrefix('255.255.0.0')).toBe(16);
        expect(__internals.netmaskToPrefix('255.255.255.255')).toBe(32);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/subnetDetector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/server/network/SubnetDetector.ts`:

```ts
import { execFile } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface DetectedSubnet {
    cidr: string;
    hostCount: number;
    source: 'gateway' | 'interface';
    interfaceName?: string;
}

export interface DetectorDeps {
    getInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    runCommand: (cmd: string) => Promise<string>;
    platform: NodeJS.Platform;
}

const DEFAULT_DEPS: DetectorDeps = {
    getInterfaces: () => os.networkInterfaces(),
    runCommand: async (cmd: string) => {
        // Spawn via shell so users can pass full command strings.
        // Wrap with 3s timeout — detection should never block startup.
        const [bin, ...args] = splitCommand(cmd);
        const { stdout } = await execFileAsync(bin, args, { timeout: 3000, maxBuffer: 1024 * 1024 });
        return stdout;
    },
    platform: process.platform,
};

export async function detectSubnet(deps: DetectorDeps = DEFAULT_DEPS): Promise<DetectedSubnet | null> {
    // 1. Try gateway detection
    try {
        const gw = await detectViaGateway(deps);
        if (gw) return gw;
    } catch {
        // fall through
    }

    // 2. Fall back to interface enumeration
    const iface = detectViaInterfaces(deps.getInterfaces());
    if (iface) return iface;

    // 3. Give up
    return null;
}

async function detectViaGateway(deps: DetectorDeps): Promise<DetectedSubnet | null> {
    if (deps.platform === 'linux' || deps.platform === 'darwin') {
        const route = await deps.runCommand('ip route show default');
        const m = route.match(/default via [\d.]+ dev (\S+)/);
        if (!m) return null;
        const ifaceName = m[1];
        const addr = await deps.runCommand(`ip -o -4 addr show dev ${ifaceName}`);
        const cidrM = addr.match(/inet (\d+\.\d+\.\d+\.\d+\/\d+)/);
        if (!cidrM) return null;
        return fromCidrString(cidrM[1], 'gateway', ifaceName);
    }

    if (deps.platform === 'win32') {
        const output = await deps.runCommand('route print -4');
        const m = output.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\S+)\s+\d+/m);
        if (!m) return null;
        const gatewayIfaceIp = m[1];
        const interfaces = deps.getInterfaces();
        for (const [name, entries] of Object.entries(interfaces)) {
            for (const entry of entries ?? []) {
                if (entry.family === 'IPv4' && !entry.internal && entry.address === gatewayIfaceIp) {
                    const prefix = __internals.netmaskToPrefix(entry.netmask);
                    if (prefix === null) return null;
                    const network = __internals.cidrNetwork(entry.address, prefix);
                    return buildDetected(`${network}/${prefix}`, 'gateway', name);
                }
            }
        }
    }

    return null;
}

function detectViaInterfaces(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): DetectedSubnet | null {
    const candidates: { name: string; entry: os.NetworkInterfaceInfo; prefix: number }[] = [];
    for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            if (!isRfc1918(entry.address)) continue;
            const prefix = __internals.netmaskToPrefix(entry.netmask);
            if (prefix === null || prefix < 16 || prefix > 32) continue;
            candidates.push({ name, entry, prefix });
        }
    }
    if (candidates.length === 0) return null;

    // Prefer smallest prefix (largest subnet = main LAN).
    candidates.sort((a, b) => a.prefix - b.prefix);
    const best = candidates[0];
    const network = __internals.cidrNetwork(best.entry.address, best.prefix);
    return buildDetected(`${network}/${best.prefix}`, 'interface', best.name);
}

function fromCidrString(cidr: string, source: 'gateway' | 'interface', ifaceName?: string): DetectedSubnet | null {
    const [ip, prefixStr] = cidr.split('/');
    const prefix = Number.parseInt(prefixStr, 10);
    if (!Number.isFinite(prefix)) return null;
    const network = __internals.cidrNetwork(ip, prefix);
    return buildDetected(`${network}/${prefix}`, source, ifaceName);
}

function buildDetected(cidr: string, source: 'gateway' | 'interface', ifaceName?: string): DetectedSubnet {
    const prefix = Number.parseInt(cidr.split('/')[1], 10);
    const hostCount = prefix === 32 ? 1 : 2 ** (32 - prefix) - 2;
    return { cidr, hostCount, source, interfaceName: ifaceName };
}

function isRfc1918(ip: string): boolean {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
}

function splitCommand(cmd: string): string[] {
    return cmd.split(/\s+/).filter(Boolean);
}

export const __internals = {
    netmaskToPrefix(mask: string): number | null {
        const parts = mask.split('.');
        if (parts.length !== 4) return null;
        let bits = 0;
        let seenZero = false;
        for (const p of parts) {
            const n = Number.parseInt(p, 10);
            if (!Number.isFinite(n) || n < 0 || n > 255) return null;
            const octetBits = (n.toString(2).match(/1/g) || []).length;
            // Confirm contiguous — no 1s after a 0.
            if (seenZero && octetBits > 0) return null;
            if (octetBits < 8) seenZero = true;
            bits += octetBits;
        }
        return bits;
    },
    cidrNetwork(ip: string, prefix: number): string {
        const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
        const ipInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
        const maskBits = 32 - prefix;
        const netmask = maskBits === 32 ? 0 : (0xffffffff << maskBits) >>> 0;
        const networkInt = (ipInt & netmask) >>> 0;
        return [
            (networkInt >>> 24) & 0xff,
            (networkInt >>> 16) & 0xff,
            (networkInt >>> 8) & 0xff,
            networkInt & 0xff,
        ].join('.');
    },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/__tests__/subnetDetector.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/network/SubnetDetector.ts src/server/__tests__/subnetDetector.test.ts
git commit -m "feat(scan): subnet detector with gateway/interface fallback"
```

---

## Task 4: NetworkScanner — state machine, start/cancel API, lifecycle messages

**Files:**
- Create: `src/server/network/NetworkScanner.ts`
- Create: `src/server/__tests__/networkScanner.test.ts`

This task establishes the public surface. TCP probing, mDNS, and dedupe are layered in tasks 5 and 6.

- [ ] **Step 1: Write initial failing tests**

Create `src/server/__tests__/networkScanner.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { NetworkScanner } from '../network/NetworkScanner';
import type { ParsedSubnet } from '../../common/SubnetParser';
import type { ScanServerMessage } from '../../common/ScanMessage';

function makeSubnet(hosts: string[]): ParsedSubnet {
    return {
        raw: 'test',
        normalized: `test/${hosts.length}`,
        hostCount: hosts.length,
        *hosts() { for (const h of hosts) yield h; },
    };
}

function makeWs(): { ws: any; messages: ScanServerMessage[] } {
    const messages: ScanServerMessage[] = [];
    const ws = {
        readyState: 1, OPEN: 1, CLOSED: 3, CLOSING: 2,
        send: (data: string) => messages.push(JSON.parse(data)),
        close: vi.fn(),
    };
    return { ws, messages };
}

describe('NetworkScanner — lifecycle', () => {
    it('emits scan.started then scan.complete on empty scan', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => false,
            concurrency: 4,
            progressInterval: 10,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet([])], ws);

        expect(messages[0].type).toBe('scan.started');
        expect(messages.at(-1)?.type).toBe('scan.complete');
    });

    it('isScanning transitions through states', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => false,
            concurrency: 4,
            progressInterval: 10,
        });
        expect(scanner.isScanning()).toBe(false);
        const { ws } = makeWs();
        const p = scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2'])], ws);
        expect(scanner.isScanning()).toBe(true);
        await p;
        expect(scanner.isScanning()).toBe(false);
    });

    it('rejects concurrent start calls', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => new Promise((r) => setTimeout(() => r(false), 50)),
            concurrency: 4,
            progressInterval: 10,
        });
        const { ws } = makeWs();
        const p1 = scanner.start([makeSubnet(['1.1.1.1'])], ws);
        await expect(scanner.start([makeSubnet(['1.1.1.2'])], ws)).rejects.toThrow(/already scanning/);
        await p1;
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/networkScanner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write initial implementation**

Create `src/server/network/NetworkScanner.ts`:

```ts
import type WS from 'ws';
import type { ParsedSubnet } from '../../common/SubnetParser';
import type { ScanServerMessage } from '../../common/ScanMessage';

export interface NetworkScannerDeps {
    adbDevices: () => Promise<{ serial: string; state: string }[]>;
    adbMdnsServices: () => Promise<{ name: string; service: string; address: string; port: number }[]>;
    adbConnect: (address: string) => Promise<string>;
    adbDisconnect: (address: string) => Promise<string>;
    tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
    concurrency: number;
    progressInterval: number;
    tcpTimeoutMs?: number;
    adbConnectTimeoutMs?: number;
}

type State = 'idle' | 'scanning' | 'draining';

export class NetworkScanner {
    private state: State = 'idle';
    private cancelFlag = false;
    private spectators = new Set<WS | any>();
    private emittedAddresses = new Set<string>();
    private foundSoFar = 0;

    constructor(private readonly deps: NetworkScannerDeps) {}

    isScanning(): boolean {
        return this.state !== 'idle';
    }

    attachSpectator(ws: WS | any): void {
        if (this.state === 'idle') return;
        this.spectators.add(ws);
    }

    cancel(): void {
        if (this.state !== 'scanning') return;
        this.cancelFlag = true;
    }

    async start(subnets: ParsedSubnet[], ws: WS | any): Promise<void> {
        if (this.state !== 'idle') {
            throw new Error('scanner already scanning');
        }
        this.state = 'scanning';
        this.cancelFlag = false;
        this.emittedAddresses.clear();
        this.foundSoFar = 0;
        this.spectators.clear();
        this.spectators.add(ws);

        try {
            const totalHosts = subnets.reduce((sum, s) => sum + s.hostCount, 0);
            this.emit({
                type: 'scan.started',
                totalHosts,
                totalSubnets: subnets.length,
                startedAt: Date.now(),
            });

            // TCP + mDNS tracks will be filled in Task 5 and 6.
            // For now, we just run a no-op scan to lock the state machine.
            await this.runTracks(subnets, totalHosts);

            if (this.cancelFlag) {
                this.state = 'draining';
                this.emit({ type: 'scan.draining' });
                // Drain is instant because the bounded pool awaits in-flight.
                // Task 6 will make this meaningful.
                this.emit({ type: 'scan.cancelled', found: this.foundSoFar });
            } else {
                this.emit({ type: 'scan.complete', found: this.foundSoFar });
            }
        } finally {
            this.state = 'idle';
            this.cancelFlag = false;
        }
    }

    // To be expanded in Tasks 5/6
    protected async runTracks(_subnets: ParsedSubnet[], _totalHosts: number): Promise<void> {
        // No-op scaffold. Task 5 implements TCP + mDNS.
    }

    protected emit(msg: ScanServerMessage): void {
        for (const ws of this.spectators) {
            if (ws.readyState !== ws.OPEN) continue;
            try {
                ws.send(JSON.stringify(msg));
            } catch {
                // Dropped spectator — silent
            }
        }
    }
}
```

- [ ] **Step 4: Run test to verify initial tests pass**

Run: `npx vitest run src/server/__tests__/networkScanner.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/network/NetworkScanner.ts src/server/__tests__/networkScanner.test.ts
git commit -m "feat(scan): NetworkScanner state machine + lifecycle messages"
```

---

## Task 5: NetworkScanner — TCP probe pool + adb confirm + dedupe

**Files:**
- Modify: `src/server/network/NetworkScanner.ts`
- Modify: `src/server/__tests__/networkScanner.test.ts`

- [ ] **Step 1: Extend tests**

Append to `src/server/__tests__/networkScanner.test.ts`:

```ts
describe('NetworkScanner — TCP track', () => {
    it('emits scan.hit for TCP-confirmed devices', async () => {
        const tcpProbe = vi.fn(async (host: string) => host === '1.1.1.2');
        const adbConnect = vi.fn(async (addr: string) =>
            addr === '1.1.1.2:5555' ? 'connected to 1.1.1.2:5555' : 'failed to connect'
        );
        const adbDisconnect = vi.fn(async () => 'disconnected');

        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect,
            adbDisconnect,
            tcpProbe,
            concurrency: 4,
            progressInterval: 1,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2', '1.1.1.3'])], ws);

        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({
            type: 'scan.hit',
            source: 'tcp',
            address: '1.1.1.2:5555',
        });
        expect(adbDisconnect).toHaveBeenCalledWith('1.1.1.2:5555');
    });

    it('emits scan.progress at the configured interval', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => false,
            concurrency: 2,
            progressInterval: 2,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4'])], ws);
        const progress = messages.filter((m) => m.type === 'scan.progress');
        // With interval 2 and 4 hosts, we expect two progress emissions.
        expect(progress.length).toBeGreaterThanOrEqual(2);
        expect(progress.at(-1)?.checked).toBe(4);
    });

    it('skips addresses already in adb devices', async () => {
        const tcpProbe = vi.fn(async () => true);
        const scanner = new NetworkScanner({
            adbDevices: async () => [{ serial: '1.1.1.1:5555', state: 'device' }],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'connected',
            adbDisconnect: async () => '',
            tcpProbe,
            concurrency: 2,
            progressInterval: 1,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2'])], ws);
        expect(tcpProbe).not.toHaveBeenCalledWith('1.1.1.1', expect.anything(), expect.anything());
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits.every((h: any) => h.address !== '1.1.1.1:5555')).toBe(true);
    });

    it('drops TCP hits whose adb connect does not return connected', async () => {
        const tcpProbe = vi.fn(async () => true);
        const adbConnect = vi.fn(async () => 'failed to connect');
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect,
            adbDisconnect: async () => '',
            tcpProbe,
            concurrency: 2,
            progressInterval: 1,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2'])], ws);
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits).toHaveLength(0);
    });

    it('respects concurrency bound', async () => {
        let current = 0;
        let maxObserved = 0;
        const tcpProbe = async () => {
            current++;
            if (current > maxObserved) maxObserved = current;
            await new Promise((r) => setTimeout(r, 10));
            current--;
            return false;
        };
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe,
            concurrency: 3,
            progressInterval: 100,
        });
        const { ws } = makeWs();
        const hosts = Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`);
        await scanner.start([makeSubnet(hosts)], ws);
        expect(maxObserved).toBeLessThanOrEqual(3);
    });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/server/__tests__/networkScanner.test.ts`
Expected: new tests FAIL (no TCP track yet).

- [ ] **Step 3: Replace `runTracks` with real TCP logic**

In `src/server/network/NetworkScanner.ts`, replace the `runTracks` stub with:

```ts
    protected async runTracks(subnets: ParsedSubnet[], totalHosts: number): Promise<void> {
        const connectedAddresses = new Set(
            (await this.deps.adbDevices()).map((d) => d.serial),
        );

        // mDNS track handled in Task 6.
        // TCP track:
        const hostList: string[] = [];
        for (const subnet of subnets) {
            for (const host of subnet.hosts()) hostList.push(host);
        }

        let checked = 0;
        const tcpTimeout = this.deps.tcpTimeoutMs ?? 300;
        const adbTimeout = this.deps.adbConnectTimeoutMs ?? 3000;

        const workers: Promise<void>[] = [];
        let cursor = 0;
        const nextHost = (): string | null => {
            if (this.cancelFlag) return null;
            if (cursor >= hostList.length) return null;
            return hostList[cursor++];
        };

        const probeOne = async (host: string): Promise<void> => {
            const address = `${host}:5555`;
            try {
                if (connectedAddresses.has(address)) return;
                const open = await this.deps.tcpProbe(host, 5555, tcpTimeout);
                if (!open) return;
                const connectOutput = await withTimeout(this.deps.adbConnect(address), adbTimeout);
                if (!connectOutput.toLowerCase().includes('connected')) return;
                await withTimeout(this.deps.adbDisconnect(address), 2000).catch(() => {});
                this.emitHit({
                    source: 'tcp',
                    address,
                    serial: this.parseSerialFromConnectOutput(connectOutput) || address,
                    name: address,
                });
            } catch {
                // Silent probe failure
            }
        };

        const worker = async (): Promise<void> => {
            for (;;) {
                const host = nextHost();
                if (host === null) return;
                await probeOne(host);
                checked++;
                if (checked % this.deps.progressInterval === 0 || checked === totalHosts) {
                    this.emit({
                        type: 'scan.progress',
                        checked,
                        total: totalHosts,
                        foundSoFar: this.foundSoFar,
                    });
                }
            }
        };

        for (let i = 0; i < Math.min(this.deps.concurrency, hostList.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
    }

    private emitHit(partial: { source: 'mdns' | 'tcp'; address: string; serial: string; name: string; label?: string }): void {
        if (this.emittedAddresses.has(partial.address)) return;
        this.emittedAddresses.add(partial.address);
        this.foundSoFar++;
        this.emit({
            type: 'scan.hit',
            source: partial.source,
            address: partial.address,
            serial: partial.serial,
            name: partial.name,
            label: partial.label ?? '',
        });
    }

    private parseSerialFromConnectOutput(output: string): string {
        // Typical: "connected to 192.168.1.5:5555" — no serial.
        // When device is already present, adb includes its serial in other commands.
        // Best-effort: return address if we can't extract.
        return '';
    }
```

Also add this helper at the top of the file (above the class):

```ts
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/server/__tests__/networkScanner.test.ts`
Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/network/NetworkScanner.ts src/server/__tests__/networkScanner.test.ts
git commit -m "feat(scan): TCP probe pool with adb confirmation"
```

---

## Task 6: NetworkScanner — mDNS track + cancel drain + spectators

**Files:**
- Modify: `src/server/network/NetworkScanner.ts`
- Modify: `src/server/__tests__/networkScanner.test.ts`

- [ ] **Step 1: Extend tests**

Append to `src/server/__tests__/networkScanner.test.ts`:

```ts
describe('NetworkScanner — mDNS track', () => {
    it('emits mDNS hits alongside TCP hits', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [
                { name: 'adb-SERIAL1', service: '_adb-tls-connect._tcp.', address: '1.1.1.5', port: 5555 },
            ],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => false,
            concurrency: 4,
            progressInterval: 10,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet([])], ws);
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ source: 'mdns', address: '1.1.1.5:5555' });
    });

    it('dedupes mDNS + TCP hits for same address (first wins)', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [
                { name: 'adb-SERIAL1', service: '_adb-tls-connect._tcp.', address: '1.1.1.5', port: 5555 },
            ],
            adbConnect: async () => 'connected',
            adbDisconnect: async () => '',
            tcpProbe: async (h) => h === '1.1.1.5',
            concurrency: 2,
            progressInterval: 1,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.5'])], ws);
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits).toHaveLength(1);
        // mDNS is synchronous here, so it wins
        expect(hits[0]).toMatchObject({ source: 'mdns', serial: 'SERIAL1' });
    });

    it('skips mDNS hits already in adb devices', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [{ serial: '1.1.1.5:5555', state: 'device' }],
            adbMdnsServices: async () => [
                { name: 'adb-SERIAL1', service: '_adb-tls-connect._tcp.', address: '1.1.1.5', port: 5555 },
            ],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => false,
            concurrency: 2,
            progressInterval: 1,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet([])], ws);
        expect(messages.filter((m) => m.type === 'scan.hit')).toHaveLength(0);
    });
});

describe('NetworkScanner — cancel drain', () => {
    it('drains in-flight probes after cancel', async () => {
        let inFlight = 0;
        let peak = 0;
        const tcpProbe = async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 20));
            inFlight--;
            return false;
        };
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe,
            concurrency: 4,
            progressInterval: 100,
        });
        const { ws, messages } = makeWs();
        const hosts = Array.from({ length: 100 }, (_, i) => `10.0.0.${i + 1}`);
        const p = scanner.start([makeSubnet(hosts)], ws);
        setTimeout(() => scanner.cancel(), 5);
        await p;

        const hasDraining = messages.some((m) => m.type === 'scan.draining');
        const hasCancelled = messages.some((m) => m.type === 'scan.cancelled');
        expect(hasDraining).toBe(true);
        expect(hasCancelled).toBe(true);
        // Should NOT have processed all 100 hosts
        const finalProgress = messages.filter((m: any) => m.type === 'scan.progress').pop();
        // Typical: well below 100 processed
        // In-flight peak limited by concurrency
        expect(peak).toBeLessThanOrEqual(4);
    });
});
```

- [ ] **Step 2: Run tests to verify mDNS/drain tests fail**

Run: `npx vitest run src/server/__tests__/networkScanner.test.ts`
Expected: new tests FAIL (no mDNS track yet; cancel emits wrong order).

- [ ] **Step 3: Add mDNS track and fix drain ordering**

In `src/server/network/NetworkScanner.ts`:

1. Add a helper to parse serial from mDNS name. Import or inline:

```ts
function parseSerialFromMdnsName(name: string, service: string): string {
    let serial = name.startsWith('adb-') ? name.slice(4) : name;
    if (service.includes('tls-connect') && serial.includes('-')) {
        serial = serial.substring(0, serial.lastIndexOf('-'));
    }
    return serial;
}
```

2. Extend `runTracks` to start an mDNS track before the TCP pool:

```ts
    protected async runTracks(subnets: ParsedSubnet[], totalHosts: number): Promise<void> {
        const connectedAddresses = new Set(
            (await this.deps.adbDevices()).map((d) => d.serial),
        );

        // Track A: mDNS — synchronous (adb returns all at once)
        const mdnsPromise = (async () => {
            try {
                const hits = await this.deps.adbMdnsServices();
                for (const hit of hits) {
                    if (this.cancelFlag) break;
                    if (!hit.service.includes('_adb') || hit.service.includes('pairing')) continue;
                    const address = `${hit.address}:${hit.port}`;
                    if (connectedAddresses.has(address)) continue;
                    this.emitHit({
                        source: 'mdns',
                        address,
                        serial: parseSerialFromMdnsName(hit.name, hit.service),
                        name: hit.name,
                    });
                }
            } catch {
                // mDNS track failed — silent; TCP track continues
            }
        })();

        // Track B: TCP (existing pool logic)
        const hostList: string[] = [];
        for (const subnet of subnets) {
            for (const host of subnet.hosts()) hostList.push(host);
        }

        let checked = 0;
        const tcpTimeout = this.deps.tcpTimeoutMs ?? 300;
        const adbTimeout = this.deps.adbConnectTimeoutMs ?? 3000;

        let cursor = 0;
        const nextHost = (): string | null => {
            if (this.cancelFlag) return null;
            if (cursor >= hostList.length) return null;
            return hostList[cursor++];
        };

        const probeOne = async (host: string): Promise<void> => {
            const address = `${host}:5555`;
            try {
                if (connectedAddresses.has(address)) return;
                if (this.emittedAddresses.has(address)) return; // mDNS already claimed
                const open = await this.deps.tcpProbe(host, 5555, tcpTimeout);
                if (!open) return;
                const connectOutput = await withTimeout(this.deps.adbConnect(address), adbTimeout);
                if (!connectOutput.toLowerCase().includes('connected')) return;
                await withTimeout(this.deps.adbDisconnect(address), 2000).catch(() => {});
                this.emitHit({
                    source: 'tcp',
                    address,
                    serial: address,
                    name: address,
                });
            } catch {
                // Silent
            }
        };

        const worker = async (): Promise<void> => {
            for (;;) {
                const host = nextHost();
                if (host === null) return;
                await probeOne(host);
                checked++;
                if (checked % this.deps.progressInterval === 0 || checked === totalHosts) {
                    this.emit({
                        type: 'scan.progress',
                        checked,
                        total: totalHosts,
                        foundSoFar: this.foundSoFar,
                    });
                }
            }
        };

        const workers: Promise<void>[] = [];
        for (let i = 0; i < Math.min(this.deps.concurrency, Math.max(hostList.length, 1)); i++) {
            workers.push(worker());
        }
        await Promise.all([mdnsPromise, ...workers]);
    }
```

3. In `start()`, emit `scan.draining` *while* workers are still in flight after cancel, not after they all finish. Update the try-block as:

```ts
        try {
            const totalHosts = subnets.reduce((sum, s) => sum + s.hostCount, 0);
            this.emit({
                type: 'scan.started',
                totalHosts,
                totalSubnets: subnets.length,
                startedAt: Date.now(),
            });

            const runPromise = this.runTracks(subnets, totalHosts);

            // Watch for cancel flag: as soon as it's set, emit scan.draining.
            const drainWatcher = (async () => {
                while (!this.cancelFlag && this.state === 'scanning') {
                    await new Promise((r) => setTimeout(r, 10));
                    if (this.state !== 'scanning') return;
                }
                if (this.cancelFlag && this.state === 'scanning') {
                    this.state = 'draining';
                    this.emit({ type: 'scan.draining' });
                }
            })();

            await runPromise;
            await drainWatcher;

            if (this.cancelFlag) {
                this.emit({ type: 'scan.cancelled', found: this.foundSoFar });
            } else {
                this.emit({ type: 'scan.complete', found: this.foundSoFar });
            }
        } finally {
            this.state = 'idle';
            this.cancelFlag = false;
        }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run src/server/__tests__/networkScanner.test.ts`
Expected: all 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/network/NetworkScanner.ts src/server/__tests__/networkScanner.test.ts
git commit -m "feat(scan): mDNS track + cancel drain"
```

---

## Task 7: ScanMw WebSocket middleware + integration test

**Files:**
- Create: `src/server/mw/ScanMw.ts`
- Create: `src/server/__tests__/scanMw.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `src/server/__tests__/scanMw.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { ScanMw } from '../mw/ScanMw';
import { NetworkScanner } from '../network/NetworkScanner';
import { SCAN_WS_PATH } from '../../common/ScanMessage';

async function collectMessages(ws: WebSocket, until: (msg: any) => boolean): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const msgs: any[] = [];
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('message', (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            msgs.push(msg);
            if (until(msg)) {
                clearTimeout(timer);
                resolve(msgs);
            }
        });
    });
}

describe('ScanMw integration', () => {
    it('accepts scan.start and streams through to scan.complete', async () => {
        // Build a bespoke scanner with deterministic deps
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => false,
            concurrency: 4,
            progressInterval: 10,
        });
        ScanMw.setScanner(scanner);

        const server = http.createServer();
        const wss = new WebSocketServer({ server });
        wss.on('connection', (ws, req) => {
            if (req.url === SCAN_WS_PATH) ScanMw.attach(ws);
        });
        await new Promise<void>((r) => server.listen(0, r));
        const port = (server.address() as any).port;

        const client = new WebSocket(`ws://127.0.0.1:${port}${SCAN_WS_PATH}`);
        await new Promise<void>((r) => client.once('open', r));

        const collected = collectMessages(client, (m) => m.type === 'scan.complete');
        client.send(JSON.stringify({ type: 'scan.start', subnets: ['192.168.1.0/30'] }));
        const messages = await collected;

        expect(messages[0].type).toBe('scan.started');
        expect(messages.at(-1).type).toBe('scan.complete');

        client.close();
        await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    });

    it('rejects scan.start with invalid subnets', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => false,
            concurrency: 4,
            progressInterval: 10,
        });
        ScanMw.setScanner(scanner);

        const server = http.createServer();
        const wss = new WebSocketServer({ server });
        wss.on('connection', (ws, req) => {
            if (req.url === SCAN_WS_PATH) ScanMw.attach(ws);
        });
        await new Promise<void>((r) => server.listen(0, r));
        const port = (server.address() as any).port;

        const client = new WebSocket(`ws://127.0.0.1:${port}${SCAN_WS_PATH}`);
        await new Promise<void>((r) => client.once('open', r));

        const collected = collectMessages(client, (m) => m.type === 'scan.error');
        client.send(JSON.stringify({ type: 'scan.start', subnets: ['garbage'] }));
        const messages = await collected;

        expect(messages[0].type).toBe('scan.error');
        expect((messages[0] as any).details).toBeDefined();

        client.close();
        await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/server/__tests__/scanMw.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the middleware**

Create `src/server/mw/ScanMw.ts`:

```ts
import type WS from 'ws';
import { parseSubnetInput, type ParsedSubnet, type ParseError } from '../../common/SubnetParser';
import { NetworkScanner } from '../network/NetworkScanner';
import type { ScanClientMessage, ScanServerMessage } from '../../common/ScanMessage';

export class ScanMw {
    private static scanner: NetworkScanner | null = null;

    public static setScanner(scanner: NetworkScanner): void {
        ScanMw.scanner = scanner;
    }

    public static attach(ws: WS): void {
        const scanner = ScanMw.scanner;
        if (!scanner) {
            ScanMw.send(ws, { type: 'scan.error', reason: 'scanner not initialized' });
            return;
        }

        if (scanner.isScanning()) {
            scanner.attachSpectator(ws);
            // Subsequent messages from a spectator are ignored except cancel.
        }

        const onMessage = (data: WS.RawData): void => {
            let msg: ScanClientMessage;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                ScanMw.send(ws, { type: 'scan.error', reason: 'invalid JSON' });
                return;
            }
            if (msg.type === 'scan.start') {
                if (scanner.isScanning()) {
                    ScanMw.send(ws, { type: 'scan.error', reason: 'scan already in progress' });
                    return;
                }
                const parsed: ParsedSubnet[] = [];
                const errors: { subnet: string; error: string }[] = [];
                for (const raw of msg.subnets) {
                    const r = parseSubnetInput(raw);
                    if ('reason' in r) {
                        errors.push({ subnet: raw, error: (r as ParseError).reason });
                    } else {
                        parsed.push(r);
                    }
                }
                if (errors.length > 0) {
                    ScanMw.send(ws, { type: 'scan.error', reason: 'invalid subnets', details: errors });
                    return;
                }
                // Fire and forget — scanner drives the WS directly.
                scanner.start(parsed, ws).catch(() => {});
                return;
            }
            if (msg.type === 'scan.cancel') {
                scanner.cancel();
                return;
            }
        };

        ws.on('message', onMessage);
        // Client disconnect does NOT cancel the scan (per spec).
    }

    private static send(ws: WS, msg: ScanServerMessage): void {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify(msg));
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/server/__tests__/scanMw.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/mw/ScanMw.ts src/server/__tests__/scanMw.test.ts
git commit -m "feat(scan): WebSocket middleware for /ws-scan"
```

---

## Task 8: Wire ScanMw into server startup

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Register ScanMw and its scanner**

Edit `src/server/index.ts`. After the `DependencyApi` registration (around line 30), add scanner setup. Near the top with other imports:

```ts
import { ScanMw } from './mw/ScanMw';
import { NetworkScanner } from './network/NetworkScanner';
import { AdbClient } from './AdbClient';
import * as net from 'net';
```

Then after `const discoveryApi = new DeviceDiscoveryApi(); HttpServer.addApiHandler(discoveryApi);` add:

```ts
// Wire the scanner singleton
const scanAdb = new AdbClient(config.adbPath);
const scanner = new NetworkScanner({
    adbDevices: () => scanAdb.devices(),
    adbMdnsServices: () => scanAdb.mdnsServices(),
    adbConnect: (addr: string) => scanAdb.connect(addr),
    adbDisconnect: (addr: string) => scanAdb.disconnect(addr),
    tcpProbe: tcpProbe5555,
    concurrency: 64,
    progressInterval: 10,
    tcpTimeoutMs: 300,
    adbConnectTimeoutMs: 3000,
});
ScanMw.setScanner(scanner);

function tcpProbe5555(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const done = (open: boolean) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch {}
            resolve(open);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}
```

- [ ] **Step 2: Hook the scan WS into the WebSocket server**

`ScanMw` uses `ScanMw.attach(ws)` directly rather than the `Mw`-factory pattern. We need to register a handler for the `/ws-scan` path on the WebSocket server.

Inspect `src/server/services/WebSocketServer.ts` to see how `mwList` entries are dispatched. If the server dispatches by URL prefix already (shared by other MWs), add a small branch. If not, accept a direct `onConnection` registration.

Add to the `.then(() => { ...wsService... })` block, after `mw2List.forEach(...)`:

```ts
        const wss = wsService.getWss?.() ?? (wsService as any).wss;
        if (wss) {
            wss.on('connection', (ws: any, req: any) => {
                if (req.url?.startsWith('/ws-scan')) {
                    ScanMw.attach(ws);
                }
            });
        }
```

(If the exact method name differs in `WebSocketServer.ts`, adjust to access the underlying `ws.WebSocketServer`. The class almost certainly exposes it.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Build and manually smoke-test**

Run: `npm run build:dev`
Expected: build succeeds with zero new warnings/errors.

Start the server: `node dist/index.js`

In a separate terminal or browser devtools, open a WS to `ws://localhost:8000/ws-scan` and send `{"type":"scan.start","subnets":["127.0.0.1/32"]}`. Expect `scan.started` → `scan.progress` → `scan.complete`.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(scan): register ScanMw and NetworkScanner at server startup"
```

---

## Task 9: Subnet cheat sheet HTML

**Files:**
- Create: `public/help/subnets.html`

- [ ] **Step 1: Write the cheat sheet**

Create `public/help/subnets.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Subnet &amp; CIDR Cheat Sheet — ws-scrcpy-web</title>
<style>
:root {
    --bg: #0d1117;
    --panel: #161b22;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --mono: ui-monospace, Consolas, "SF Mono", "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 15px; line-height: 1.6; }
main { max-width: 780px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 40px 0 12px; padding-top: 12px; border-top: 1px solid #30363d; }
p { margin: 0 0 12px; }
code, .mono { font-family: var(--mono); font-size: 0.95em; background: var(--panel); padding: 2px 6px; border-radius: 4px; }
pre { background: var(--panel); padding: 12px 16px; border-radius: 6px; overflow-x: auto; font-family: var(--mono); font-size: 13px; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-family: var(--mono); font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #30363d; }
th { color: var(--muted); font-weight: 600; }
.muted { color: var(--muted); }
.back { display: inline-block; margin-top: 32px; color: var(--accent); text-decoration: none; }
.back:hover { text-decoration: underline; }
.footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #30363d; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<main>
<h1>Subnet &amp; CIDR Cheat Sheet</h1>
<p class="muted">A plain-English guide to the subnet formats ws-scrcpy-web accepts.</p>

<h2>What is a subnet?</h2>
<p>An IP address is split into two parts: one part identifies the <em>network</em>, the other identifies a specific <em>host</em> (device) on that network. A <strong>subnet</strong> is a named range of addresses that all share the same network part.</p>
<p>On a home network, every device you own — phone, laptop, TV, router — is on the same subnet. Scanning a subnet means checking every possible host address in that range.</p>

<h2>What is CIDR notation?</h2>
<p>CIDR (Classless Inter-Domain Routing) writes a subnet as an address plus a slash number, like <code>192.168.1.0/24</code>. The number after the slash is the <strong>prefix length</strong> — how many bits (out of 32) belong to the network part.</p>
<p>The smaller the prefix, the bigger the subnet. <code>/24</code> holds 256 addresses (254 usable); <code>/16</code> holds 65,536 addresses.</p>

<table>
<thead><tr><th>Prefix</th><th>Mask</th><th>Total addresses</th><th>Usable hosts</th></tr></thead>
<tbody>
<tr><td>/16</td><td>255.255.0.0</td><td>65,536</td><td>65,534</td></tr>
<tr><td>/20</td><td>255.255.240.0</td><td>4,096</td><td>4,094</td></tr>
<tr><td>/22</td><td>255.255.252.0</td><td>1,024</td><td>1,022</td></tr>
<tr><td>/23</td><td>255.255.254.0</td><td>512</td><td>510</td></tr>
<tr><td>/24</td><td>255.255.255.0</td><td>256</td><td>254</td></tr>
<tr><td>/25</td><td>255.255.255.128</td><td>128</td><td>126</td></tr>
<tr><td>/28</td><td>255.255.255.240</td><td>16</td><td>14</td></tr>
<tr><td>/30</td><td>255.255.255.252</td><td>4</td><td>2</td></tr>
<tr><td>/32</td><td>255.255.255.255</td><td>1</td><td>1</td></tr>
</tbody>
</table>
<p class="muted">"Usable hosts" excludes the network address (first) and broadcast address (last) for prefixes /30 and shorter.</p>

<h2>Private IP ranges (RFC 1918)</h2>
<p>Home and office networks use one of three IP address ranges that are reserved for private use. Your router picks one and hands out addresses inside it to every device.</p>
<ul>
<li><code>10.0.0.0/8</code> — 16,777,216 addresses. Often used in large organizations.</li>
<li><code>172.16.0.0/12</code> — 1,048,576 addresses. Less common.</li>
<li><code>192.168.0.0/16</code> — 65,536 addresses. The default for most home routers.</li>
</ul>

<h2>What does my home router use?</h2>
<p>Most consumer routers (Netgear, TP-Link, Linksys, Google Wifi, etc.) default to either <code>192.168.0.0/24</code> or <code>192.168.1.0/24</code>. Some ISPs (including Xfinity and Verizon) use <code>192.168.86.0/24</code> or similar.</p>
<p>To check your own subnet:</p>
<ul>
<li><strong>Windows:</strong> open Command Prompt, run <code>ipconfig</code>. Look for "IPv4 Address" and "Subnet Mask" under your Wi-Fi or Ethernet adapter.</li>
<li><strong>Mac / Linux:</strong> open Terminal, run <code>ifconfig</code> or <code>ip addr</code>. Look for an <code>inet</code> line showing your address and <code>/N</code> prefix.</li>
</ul>
<p>If your IPv4 address is <code>192.168.1.42</code> with netmask <code>255.255.255.0</code>, you're on <code>192.168.1.0/24</code>.</p>

<h2>How to enter subnets in ws-scrcpy-web</h2>
<p>The "add subnet" dialog accepts three formats:</p>

<p><strong>1. CIDR notation</strong> — the canonical form. Examples:</p>
<pre>192.168.1.0/24
10.0.0.0/16
192.168.86.0/24</pre>
<p>Prefixes from <code>/16</code> to <code>/32</code> are allowed. Larger prefixes (<code>/15</code> and below) are rejected because scanning more than 65,534 hosts at once is impractically slow. If you need to cover more, add multiple <code>/16</code> entries.</p>

<p><strong>2. Single IP</strong> — treated as <code>/32</code> (one host). Useful when you know exactly one device's address:</p>
<pre>192.168.1.5</pre>

<p><strong>3. IP range</strong> — a contiguous block within a single <code>/24</code>. Two forms:</p>
<pre>192.168.1.10-192.168.1.50
192.168.1.10-50</pre>
<p>Both mean "addresses <code>.10</code> through <code>.50</code> on the <code>192.168.1.x</code> network" — 41 hosts. Ranges must stay within the same <code>/24</code> (only the last number changes). For wider ranges, use CIDR.</p>

<h2>What does the scan actually do?</h2>
<p>For each host in the subnets you've listed, ws-scrcpy-web does two things in parallel:</p>
<ul>
<li><strong>mDNS discovery</strong> — asks the local network which devices advertise the ADB service. Modern Android devices with wireless debugging enabled usually show up here.</li>
<li><strong>TCP port-5555 probe</strong> — tries to open a TCP connection to port 5555 on each host. If it succeeds, the scanner runs <code>adb connect</code> to confirm the host actually speaks ADB (not just something else listening on that port), then disconnects cleanly and adds the host to your available devices list.</li>
</ul>
<p>The scan is read-only: nothing is written to or changed on any device. It's equivalent to checking whether each address has a doorbell, without entering.</p>

<a class="back" href="../">&larr; Back to ws-scrcpy-web</a>

<div class="footer">
References: RFC 1918 (Private IPv4 address allocation) · RFC 4632 (CIDR notation).<br>
Written for ws-scrcpy-web. No third-party content.
</div>
</main>
</body>
</html>
```

- [ ] **Step 2: Verify the file opens and renders**

Open `public/help/subnets.html` in a browser. Confirm:
- Dark theme, readable text, no broken CSS.
- Table renders properly.
- "Back to ws-scrcpy-web" link present.
- File size under 15 KB (`ls -la public/help/subnets.html`).

- [ ] **Step 3: Commit**

```bash
git add public/help/subnets.html
git commit -m "feat(scan): subnet and CIDR cheat sheet page"
```

---

## Task 10: AddSubnetModal

**Files:**
- Create: `src/app/client/AddSubnetModal.ts`

The existing Modal base class (`src/app/ui/Modal.ts`) provides `<dialog>` scaffolding. This modal lives *inside* the primary scan dialog as a second-layer modal.

- [ ] **Step 1: Write the modal**

Create `src/app/client/AddSubnetModal.ts`:

```ts
import { Modal } from '../ui/Modal';

export interface AddSubnetModalOptions {
    onAdded: (rawSubnet: string) => void;
}

export class AddSubnetModal extends Modal {
    private input!: HTMLInputElement;
    private status!: HTMLDivElement;
    private addBtn!: HTMLButtonElement;
    private readonly addedCallback: (rawSubnet: string) => void;

    constructor(options: AddSubnetModalOptions) {
        super({ title: 'Add Subnet to Scan' });
        this.addedCallback = options.onAdded;
        this.dialog.classList.add('add-subnet-modal');
    }

    protected buildBody(container: HTMLElement): void {
        const help = document.createElement('p');
        help.textContent = 'Accepted formats: CIDR (192.168.2.0/24), single IP (192.168.2.5), or range (192.168.2.10-50).';
        help.style.cssText = 'margin: 0 0 12px; color: var(--muted, #8b949e); font-size: 13px;';
        container.appendChild(help);

        this.input = document.createElement('input');
        this.input.type = 'text';
        this.input.placeholder = '192.168.2.0/24 or 192.168.2.5 or 192.168.2.10-50';
        this.input.style.cssText = 'width: 100%; padding: 8px; font-family: var(--font-mono, monospace);';
        this.input.addEventListener('input', () => this.revalidate());
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !this.addBtn.disabled) this.submit();
        });
        container.appendChild(this.input);

        this.status = document.createElement('div');
        this.status.style.cssText = 'min-height: 18px; margin-top: 8px; font-size: 13px;';
        container.appendChild(this.status);
    }

    protected buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        const cancel = document.createElement('button');
        cancel.textContent = 'cancel';
        cancel.addEventListener('click', () => this.close());
        this.addBtn = document.createElement('button');
        this.addBtn.textContent = 'add';
        this.addBtn.disabled = true;
        this.addBtn.addEventListener('click', () => this.submit());
        footer.appendChild(cancel);
        footer.appendChild(this.addBtn);
        return footer;
    }

    private revalidate(): void {
        const raw = this.input.value.trim();
        if (!raw) {
            this.status.textContent = '';
            this.addBtn.disabled = true;
            return;
        }
        // Client-side validation mirrors the server-side parser for instant feedback.
        // We re-use the same logic by lazy-importing to avoid shipping the whole server bundle.
        import('../../common/SubnetParser').then(({ parseSubnetInput }) => {
            const r = parseSubnetInput(raw);
            if ('reason' in r) {
                this.status.textContent = `✗ ${r.reason}`;
                this.status.style.color = '#f06c75';
                this.addBtn.disabled = true;
            } else {
                const label = r.normalized.includes('/32')
                    ? `✓ single host`
                    : r.normalized.includes('-')
                        ? `✓ range, ${r.hostCount} host${r.hostCount === 1 ? '' : 's'}`
                        : `✓ CIDR, ${r.hostCount} host${r.hostCount === 1 ? '' : 's'}`;
                this.status.textContent = label;
                this.status.style.color = '#8ad67a';
                this.addBtn.disabled = false;
            }
        });
    }

    private submit(): void {
        const raw = this.input.value.trim();
        if (!raw) return;
        this.addedCallback(raw);
        this.close();
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/client/AddSubnetModal.ts
git commit -m "feat(scan): AddSubnetModal with live validation"
```

---

## Task 11: LargeSubnetWarningModal

**Files:**
- Create: `src/app/client/LargeSubnetWarningModal.ts`

- [ ] **Step 1: Write the modal**

Create `src/app/client/LargeSubnetWarningModal.ts`:

```ts
import { Modal } from '../ui/Modal';

export interface LargeSubnetWarningOptions {
    totalHosts: number;
    subnetBreakdown: { normalized: string; hostCount: number; annotation: string }[];
    onContinue: () => void;
}

export class LargeSubnetWarningModal extends Modal {
    private readonly data: LargeSubnetWarningOptions;

    constructor(options: LargeSubnetWarningOptions) {
        super({ title: 'Large Scan — Confirm' });
        this.data = options;
        this.dialog.classList.add('large-subnet-warning-modal');
    }

    protected buildBody(container: HTMLElement): void {
        const summary = document.createElement('p');
        summary.innerHTML =
            `The scan covers <strong>${this.data.totalHosts.toLocaleString()} hosts</strong> ` +
            `across <strong>${this.data.subnetBreakdown.length} subnet${this.data.subnetBreakdown.length === 1 ? '' : 's'}</strong>. ` +
            `At roughly 30 seconds per 1,000 hosts, this will take about <strong>${formatDuration(this.data.totalHosts)}</strong>.`;
        container.appendChild(summary);

        const list = document.createElement('ul');
        list.style.cssText = 'font-family: var(--font-mono, monospace); font-size: 13px; padding-left: 20px;';
        for (const row of this.data.subnetBreakdown) {
            const li = document.createElement('li');
            li.textContent = `${row.normalized} — ${row.hostCount.toLocaleString()} host${row.hostCount === 1 ? '' : 's'} (${row.annotation})`;
            list.appendChild(li);
        }
        container.appendChild(list);

        const advice = document.createElement('p');
        advice.textContent = 'To narrow the scan, cancel and edit subnets. Otherwise continue.';
        advice.style.cssText = 'margin-top: 12px; color: var(--muted, #8b949e); font-size: 13px;';
        container.appendChild(advice);
    }

    protected buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        const cancel = document.createElement('button');
        cancel.textContent = 'cancel';
        cancel.addEventListener('click', () => this.close());
        const cont = document.createElement('button');
        cont.textContent = 'continue scan';
        cont.addEventListener('click', () => {
            this.data.onContinue();
            this.close();
        });
        footer.appendChild(cancel);
        footer.appendChild(cont);
        return footer;
    }
}

function formatDuration(totalHosts: number): string {
    const seconds = Math.round((totalHosts / 1000) * 30);
    if (seconds < 60) return `${seconds} seconds`;
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/client/LargeSubnetWarningModal.ts
git commit -m "feat(scan): LargeSubnetWarningModal with host-count breakdown"
```

---

## Task 12: ScanNetworkModal

**Files:**
- Create: `src/app/client/ScanNetworkModal.ts`

- [ ] **Step 1: Write the modal**

Create `src/app/client/ScanNetworkModal.ts`:

```ts
import { Modal } from '../ui/Modal';
import { AddSubnetModal } from './AddSubnetModal';
import { LargeSubnetWarningModal } from './LargeSubnetWarningModal';

const LS_KEY = 'ws-scrcpy-web:scan-subnets';

interface SubnetRow {
    raw: string;
    normalized: string;
    hostCount: number;
    annotation: string; // 'detected gateway subnet' | 'manually added'
    removable: boolean;
}

export interface ScanNetworkModalOptions {
    gatewaySubnet: {
        cidr: string;
        hostCount: number;
    } | null;
    onStartScan: (rawSubnets: string[]) => void;
}

export class ScanNetworkModal extends Modal {
    private readonly opts: ScanNetworkModalOptions;
    private rows: SubnetRow[] = [];
    private subnetListEl!: HTMLElement;
    private startBtn!: HTMLButtonElement;
    private emptyNotice!: HTMLElement;

    constructor(options: ScanNetworkModalOptions) {
        super({ title: 'Scan Network for Devices' });
        this.opts = options;
        this.dialog.classList.add('scan-network-modal');
        this.loadInitialRows();
        this.renderSubnetList();
        this.updateStartButton();
    }

    protected buildBody(container: HTMLElement): void {
        const explain = document.createElement('p');
        explain.textContent =
            'This scans your local network for Android devices with wireless debugging enabled. ' +
            'It checks mDNS broadcasts (modern devices) and probes port 5555 on each host in the ' +
            'selected subnets (older devices).';
        container.appendChild(explain);

        const warning = document.createElement('div');
        warning.style.cssText =
            'background: rgba(240,108,117,0.12); border: 1px solid #f06c75; color: #f06c75; ' +
            'padding: 10px 12px; border-radius: 4px; margin: 12px 0; font-size: 13px;';
        warning.innerHTML =
            '⚠ Scanning sends connection attempts to every host on the selected subnet(s). ' +
            'On managed or corporate networks this may trigger intrusion-detection alerts. ' +
            'Only scan networks you own or administer.';
        container.appendChild(warning);

        const listHeader = document.createElement('div');
        listHeader.textContent = 'Subnets to scan:';
        listHeader.style.cssText = 'margin-top: 8px; font-weight: 600;';
        container.appendChild(listHeader);

        this.emptyNotice = document.createElement('div');
        this.emptyNotice.style.cssText = 'color: #d0a050; font-size: 13px; padding: 6px 0;';
        this.emptyNotice.textContent = "Couldn't detect your gateway subnet. Add at least one subnet below to scan.";
        container.appendChild(this.emptyNotice);

        this.subnetListEl = document.createElement('ul');
        this.subnetListEl.style.cssText = 'list-style: none; padding: 0; margin: 8px 0; font-family: var(--font-mono, monospace); font-size: 13px;';
        container.appendChild(this.subnetListEl);

        const addBtn = document.createElement('button');
        addBtn.textContent = 'add subnet';
        addBtn.style.cssText = 'margin: 4px 0 12px;';
        addBtn.addEventListener('click', () => this.openAddSubnet());
        container.appendChild(addBtn);

        const cheatLink = document.createElement('p');
        cheatLink.style.cssText = 'font-size: 12px; color: var(--muted, #8b949e);';
        cheatLink.innerHTML = 'New to CIDR? See the <a href="help/subnets.html" target="_blank" rel="noopener">subnet cheat sheet</a>.';
        container.appendChild(cheatLink);
    }

    protected buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        const cancel = document.createElement('button');
        cancel.textContent = 'cancel';
        cancel.addEventListener('click', () => this.close());
        this.startBtn = document.createElement('button');
        this.startBtn.textContent = 'start scan';
        this.startBtn.disabled = true;
        this.startBtn.addEventListener('click', () => this.onStartClick());
        footer.appendChild(cancel);
        footer.appendChild(this.startBtn);
        return footer;
    }

    private loadInitialRows(): void {
        this.rows = [];
        if (this.opts.gatewaySubnet) {
            this.rows.push({
                raw: this.opts.gatewaySubnet.cidr,
                normalized: this.opts.gatewaySubnet.cidr,
                hostCount: this.opts.gatewaySubnet.hostCount,
                annotation: 'detected gateway subnet',
                removable: false,
            });
        }
        const saved = this.loadSavedSubnets();
        for (const raw of saved) {
            this.addUserRow(raw);
        }
    }

    private loadSavedSubnets(): string[] {
        try {
            const v = localStorage.getItem(LS_KEY);
            if (!v) return [];
            const arr = JSON.parse(v);
            return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
        } catch {
            return [];
        }
    }

    private saveSubnets(): void {
        const raws = this.rows.filter((r) => r.removable).map((r) => r.raw);
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(raws));
        } catch {
            // Storage full or disabled — ignore
        }
    }

    private async addUserRow(raw: string): Promise<void> {
        const { parseSubnetInput } = await import('../../common/SubnetParser');
        const r = parseSubnetInput(raw);
        if ('reason' in r) return; // Already validated by AddSubnetModal; defensive skip.
        this.rows.push({
            raw,
            normalized: r.normalized,
            hostCount: r.hostCount,
            annotation: 'manually added',
            removable: true,
        });
        this.saveSubnets();
        this.renderSubnetList();
        this.updateStartButton();
    }

    private removeRow(idx: number): void {
        this.rows.splice(idx, 1);
        this.saveSubnets();
        this.renderSubnetList();
        this.updateStartButton();
    }

    private renderSubnetList(): void {
        this.subnetListEl.innerHTML = '';
        const hasAny = this.rows.length > 0;
        this.emptyNotice.style.display = hasAny ? 'none' : '';
        for (let i = 0; i < this.rows.length; i++) {
            const row = this.rows[i];
            const li = document.createElement('li');
            li.style.cssText = 'padding: 4px 0; display: flex; justify-content: space-between; align-items: center;';
            const label = document.createElement('span');
            label.textContent = `${row.normalized} — ${row.hostCount.toLocaleString()} host${row.hostCount === 1 ? '' : 's'} (${row.annotation})`;
            li.appendChild(label);
            if (row.removable) {
                const x = document.createElement('button');
                x.textContent = '×';
                x.setAttribute('aria-label', 'remove');
                x.style.cssText = 'background: none; border: none; color: #f06c75; font-size: 16px; cursor: pointer;';
                const idx = i;
                x.addEventListener('click', () => this.removeRow(idx));
                li.appendChild(x);
            }
            this.subnetListEl.appendChild(li);
        }
    }

    private updateStartButton(): void {
        const total = this.rows.reduce((s, r) => s + r.hostCount, 0);
        this.startBtn.disabled = total === 0;
    }

    private openAddSubnet(): void {
        new AddSubnetModal({
            onAdded: (raw: string) => void this.addUserRow(raw),
        });
    }

    private onStartClick(): void {
        const total = this.rows.reduce((s, r) => s + r.hostCount, 0);
        const rawSubnets = this.rows.map((r) => r.raw);
        if (total > 2048) {
            new LargeSubnetWarningModal({
                totalHosts: total,
                subnetBreakdown: this.rows.map((r) => ({
                    normalized: r.normalized,
                    hostCount: r.hostCount,
                    annotation: r.annotation,
                })),
                onContinue: () => {
                    this.close();
                    this.opts.onStartScan(rawSubnets);
                },
            });
            return;
        }
        this.close();
        this.opts.onStartScan(rawSubnets);
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/client/ScanNetworkModal.ts
git commit -m "feat(scan): ScanNetworkModal — primary scan configuration dialog"
```

---

## Task 13: ScanProgressChip

**Files:**
- Create: `src/app/client/ScanProgressChip.ts`

- [ ] **Step 1: Write the chip component**

Create `src/app/client/ScanProgressChip.ts`:

```ts
export type ChipState = 'scanning' | 'draining' | 'complete' | 'cancelled';

export interface ScanProgressChipOptions {
    parent: HTMLElement; // mounts inside this element
    onCancel: () => void;
}

export class ScanProgressChip {
    private readonly el: HTMLDivElement;
    private readonly label: HTMLSpanElement;
    private readonly cancelBtn: HTMLButtonElement;
    private readonly dismissBtn: HTMLButtonElement;
    private autoHideTimer?: number;

    constructor(private readonly opts: ScanProgressChipOptions) {
        this.el = document.createElement('div');
        this.el.className = 'scan-progress-chip';
        this.el.style.cssText =
            'display: flex; align-items: center; gap: 12px; padding: 6px 12px; margin: 6px 0; ' +
            'background: rgba(88,166,255,0.12); border: 1px solid #58a6ff; border-radius: 16px; ' +
            'font-size: 13px; font-family: var(--font-mono, monospace); color: var(--text, #e6edf3);';

        this.label = document.createElement('span');
        this.el.appendChild(this.label);

        this.cancelBtn = document.createElement('button');
        this.cancelBtn.textContent = 'cancel';
        this.cancelBtn.style.cssText = 'margin-left: auto;';
        this.cancelBtn.addEventListener('click', () => this.opts.onCancel());
        this.el.appendChild(this.cancelBtn);

        this.dismissBtn = document.createElement('button');
        this.dismissBtn.textContent = '×';
        this.dismissBtn.setAttribute('aria-label', 'dismiss');
        this.dismissBtn.style.cssText = 'margin-left: auto; background: none; border: none; color: var(--muted, #8b949e); cursor: pointer;';
        this.dismissBtn.addEventListener('click', () => this.dismiss());
        this.dismissBtn.hidden = true;
        this.el.appendChild(this.dismissBtn);

        this.opts.parent.insertBefore(this.el, this.opts.parent.firstChild);
        this.setScanning(0, 0, 0);
    }

    setScanning(checked: number, total: number, foundSoFar: number): void {
        this.setState('scanning');
        const counter = total > 0 ? ` · ${checked} / ${total}` : '';
        const found = foundSoFar > 0 ? ` · ${foundSoFar} found` : '';
        this.label.textContent = `Scanning network${counter}${found}`;
    }

    setDraining(): void {
        this.setState('draining');
        this.label.textContent = 'Finishing active scans…';
    }

    setComplete(found: number): void {
        this.setState('complete');
        this.label.textContent = `Scan complete · ${found} device${found === 1 ? '' : 's'} found`;
        this.scheduleAutoHide(5000);
    }

    setCancelled(found: number): void {
        this.setState('cancelled');
        this.label.textContent = `Scan cancelled · ${found} device${found === 1 ? '' : 's'} found`;
        this.scheduleAutoHide(10000);
    }

    dismiss(): void {
        if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
        this.el.remove();
    }

    private setState(state: ChipState): void {
        this.cancelBtn.hidden = state !== 'scanning';
        this.dismissBtn.hidden = state !== 'complete' && state !== 'cancelled';
    }

    private scheduleAutoHide(ms: number): void {
        if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
        this.autoHideTimer = setTimeout(() => this.dismiss(), ms) as unknown as number;
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/client/ScanProgressChip.ts
git commit -m "feat(scan): ScanProgressChip with four lifecycle states"
```

---

## Task 14: NetworkDiscoveryPanel integration — WS client, new modal, chip mount

**Files:**
- Modify: `src/app/client/NetworkDiscoveryPanel.ts`

This task rewires the existing panel to use the new dialog and WebSocket streaming. The `manually add` flow stays untouched. The `scan network` button now opens `ScanNetworkModal`.

- [ ] **Step 1: Add a server-side endpoint for gateway subnet detection**

The dialog needs to know the detected gateway subnet on open. We have two options: expose a REST endpoint for detection, or run detection on the client (impossible). Go with REST.

Edit `src/server/api/DeviceDiscoveryApi.ts`. After the `POST /api/devices/scan` block (around line 43), add a new handler. Add this import at top:

```ts
import { detectSubnet } from '../network/SubnetDetector';
```

Add this block inside the `try {` of `handle`, near the `POST /api/devices/scan` case:

```ts
            if (req.method === 'GET' && url === '/api/devices/scan/subnet') {
                const detected = await detectSubnet();
                res.writeHead(200);
                res.end(JSON.stringify(detected));
                return true;
            }
```

- [ ] **Step 2: Rewrite `scan()` in NetworkDiscoveryPanel**

Edit `src/app/client/NetworkDiscoveryPanel.ts`. Add imports at top:

```ts
import { ScanNetworkModal } from './ScanNetworkModal';
import { ScanProgressChip } from './ScanProgressChip';
import { SCAN_WS_PATH, type ScanServerMessage } from '../../common/ScanMessage';
```

Replace the existing `scan()` method with:

```ts
    private async scan(): Promise<void> {
        // Fetch detected gateway subnet first
        let gateway: { cidr: string; hostCount: number } | null = null;
        try {
            const res = await fetch('/api/devices/scan/subnet');
            gateway = await res.json();
        } catch {
            gateway = null;
        }

        new ScanNetworkModal({
            gatewaySubnet: gateway,
            onStartScan: (rawSubnets: string[]) => this.startScanWs(rawSubnets),
        });
    }

    private chip?: ScanProgressChip;
    private scanWs?: WebSocket;
    private scanSessionHits = new Map<string, HTMLElement>();

    private startScanWs(rawSubnets: string[]): void {
        // Clear the panel before a new scan (matches existing behavior)
        this.resultsContainer.innerHTML = '';
        this.scanSessionHits.clear();
        const grid = document.createElement('div');
        grid.className = 'discovery-grid';
        this.resultsContainer.appendChild(grid);

        // Mount the chip
        this.chip?.dismiss();
        this.chip = new ScanProgressChip({
            parent: this.container.querySelector('.discovery-header') as HTMLElement,
            onCancel: () => {
                if (this.scanWs?.readyState === WebSocket.OPEN) {
                    this.scanWs.send(JSON.stringify({ type: 'scan.cancel' }));
                }
            },
        });

        // Open the WS
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}${SCAN_WS_PATH}`);
        this.scanWs = ws;

        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ type: 'scan.start', subnets: rawSubnets }));
        });
        ws.addEventListener('message', (ev: MessageEvent) => {
            const msg: ScanServerMessage = JSON.parse(ev.data);
            this.handleScanMessage(msg, grid);
        });
        ws.addEventListener('close', () => {
            this.scanWs = undefined;
        });
        ws.addEventListener('error', () => {
            this.setInfoText('Scan connection failed.', true);
            this.chip?.dismiss();
        });
    }

    private handleScanMessage(msg: ScanServerMessage, grid: HTMLElement): void {
        switch (msg.type) {
            case 'scan.started':
                this.chip?.setScanning(0, msg.totalHosts, 0);
                break;
            case 'scan.progress':
                this.chip?.setScanning(msg.checked, msg.total, msg.foundSoFar);
                break;
            case 'scan.hit':
                this.renderHit(msg, grid);
                break;
            case 'scan.draining':
                this.chip?.setDraining();
                break;
            case 'scan.complete':
                this.chip?.setComplete(msg.found);
                break;
            case 'scan.cancelled':
                this.chip?.setCancelled(msg.found);
                break;
            case 'scan.error':
                this.setInfoText(`Scan error: ${msg.reason}`, true);
                this.chip?.dismiss();
                break;
        }
    }

    private renderHit(hit: { address: string; serial: string; name: string; label: string }, grid: HTMLElement): void {
        if (this.scanSessionHits.has(hit.address)) return;
        const card = document.createElement('div');
        card.className = 'discovery-card';
        card.innerHTML = `
            <div class="discovery-card-info">
                <div class="discovery-card-name">${hit.name || hit.address}</div>
                <div class="discovery-card-address">${hit.address}</div>
            </div>
            <div class="discovery-card-actions">
                <input type="text" class="discovery-name-input" placeholder="Name this device..." value="${hit.label || ''}" />
                <button class="dep-btn dep-update discovery-connect-btn" data-address="${hit.address}" data-serial="${hit.serial}">Connect</button>
            </div>
        `;
        card.querySelector('.discovery-connect-btn')!.addEventListener('click', () =>
            this.connectDevice(hit.address, hit.serial, card),
        );
        grid.appendChild(card);
        this.scanSessionHits.set(hit.address, card);
    }
```

Also remove the now-obsolete `renderResults(devices: MdnsDevice[])` method (we stream hits now).

- [ ] **Step 3: Build and smoke-test in browser**

Run: `npm run build:dev && node dist/index.js`

In another terminal/browser:
1. Navigate to `http://localhost:8000/`.
2. Click `scan network` — the new dialog opens with detected subnet.
3. Click `add subnet`, type `192.168.1.0/24`, verify live validation → green "✓ CIDR, 254 hosts".
4. Click `add`, verify row appears with × button.
5. Reload page — verify the added subnet persisted via localStorage.
6. Click the × to remove.
7. Click `start scan`. The dialog closes, chip appears, hits start to stream in.
8. Click Cancel mid-scan — chip shows "Finishing active scans…", then "Scan cancelled · N devices found", then auto-hides in 10s.

- [ ] **Step 4: Commit**

```bash
git add src/app/client/NetworkDiscoveryPanel.ts src/server/api/DeviceDiscoveryApi.ts
git commit -m "feat(scan): NetworkDiscoveryPanel WS streaming + new dialog integration"
```

---

## Task 15: CHANGELOG + manual QA + TODO memory update

**Files:**
- Modify: `CHANGELOG.md`
- External: `C:\Users\jscha\.claude\projects\C--Users-jscha\memory\project_wsscrcpy_todo.md`

- [ ] **Step 1: Add CHANGELOG entry**

Edit `CHANGELOG.md`. Under the Unreleased section (or create one at top if missing), add:

```markdown
### Added
- Network scan now includes a port-5555 sweep alongside mDNS discovery, finding older Android devices that don't advertise themselves. Configurable via a new dialog with detected gateway subnet, user-added subnets persisted in localStorage, and live validation. Streaming progress and results via a new `/ws-scan` WebSocket endpoint. Subnet & CIDR cheat sheet at `/help/subnets.html`.

### Changed
- `Scan network` button now opens a configuration dialog. `POST /api/devices/scan` remains as a REST compatibility shim (mDNS-only).
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests pass (including pre-existing suites and the new ones from Tasks 2, 3, 4, 5, 6, 7).

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no new warnings.

- [ ] **Step 4: Full manual test checklist**

Run through the spec's manual test list:

- [ ] Primary dialog opens; gateway subnet shown with correct host count.
- [ ] Add subnet modal accepts CIDR, IP, range; rejects garbage with specific friendly error + cheat-sheet link.
- [ ] Additional subnets persist across page reload.
- [ ] Large-subnet warning fires at > 2,048 hosts, not at 2,048.
- [ ] Progress chip counter updates every ~10 hosts.
- [ ] Cancel triggers drain state, then cancelled state.
- [ ] Completed state auto-hides at 5s; cancelled at 10s.
- [ ] Cheat sheet link opens in new tab, renders cleanly.
- [ ] Gateway detection fallback: disable wifi, reload, verify dialog shows "couldn't detect" notice and scan button is disabled until subnet added.
- [ ] mDNS and TCP hits for the same device dedupe; mDNS metadata wins.
- [ ] Device already connected (in `adb devices`) is skipped.
- [ ] Connect button on a discovered card still works via the existing `POST /api/devices/connect` path.

- [ ] **Step 5: Commit CHANGELOG**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): port-5555 scan fallback"
```

- [ ] **Step 6: Update TODO memory**

Edit `C:\Users\jscha\.claude\projects\C--Users-jscha\memory\project_wsscrcpy_todo.md`:

1. Remove item 5 (ARP + port 5555 fallback scan) from the active list.
2. Add a line under "Shelved / Completed" noting this feature shipped.
3. Update the header description accordingly.

(Memory edits are not git-committed — they live in the user's Claude memory directory.)

---

## Self-review checklist (run after writing all tasks)

**Spec coverage:**
- [x] No cap; warning modal if total host count > 2,048 → Task 12 (onStartClick)
- [x] Dialog closes on scan start; progress chip in existing panel → Task 14
- [x] CIDR + bare IP + IP range; localStorage persistence → Task 2 + Task 12
- [x] Stop enqueueing, let in-flight drain; "Finishing active scans…" → Task 6
- [x] Try default gateway → fall back to interface → fall back to manual-entry-only → Task 3
- [x] WebSocket (`/ws-scan`) → Task 1, 7, 8, 14
- [x] Static HTML in `public/help/subnets.html` → Task 9
- [x] `adb connect` → `adb disconnect` → list in panel; user clicks Connect to re-engage → Task 5, 14
- [x] New `NetworkScanner` class + `ScanMw` WS middleware → Task 4, 5, 6, 7
- [x] Dedupe by `IP:port`; mDNS metadata wins when both sources hit → Task 5, 6
- [x] Devices present in `adb devices` are omitted from hit stream → Task 5, 6

**Placeholder scan:** No TBDs, no "implement later", no vague "add error handling" steps. Every code step has complete code.

**Type consistency:**
- `ParsedSubnet` defined in Task 2 and used in Tasks 4–7, 10, 12 — same shape throughout.
- `ScanServerMessage` union defined in Task 1 and used in Tasks 4–7, 14 — consistent.
- `NetworkScannerDeps` defined in Task 4 and extended (not altered) in Tasks 5/6.
- `ScanProgressChip` API (`setScanning`, `setDraining`, `setComplete`, `setCancelled`, `dismiss`) used consistently in Task 14.

No issues found.
