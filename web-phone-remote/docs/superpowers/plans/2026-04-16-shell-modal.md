# Shell Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the ADB shell terminal from a new-tab full-page experience to a centered glassmorphism modal overlay on the home page.

**Architecture:** Create a new `ShellModal` class that handles the modal DOM, xterm.js terminal, and WebSocket lifecycle. Reuse the existing multiplexed WebSocket infrastructure (`ManagerClient.sockets`, `Multiplexer`, `ChannelCode.SHEL`) and the existing server-side `RemoteShell` middleware — no backend changes. Intercept shell link clicks in DeviceTracker to open the modal instead of navigating.

**Tech Stack:** TypeScript, xterm.js (Terminal + FitAddon + AttachAddon), WebSocket multiplexing, CSS (reusing dialog.css with shell-specific overrides)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/app/googDevice/client/ShellModal.ts` | Create | Modal class: DOM creation, xterm.js lifecycle, WebSocket connection, cleanup |
| `src/style/dialog.css` | Modify | Add shell-specific sizing overrides (`.dialog-container.shell-modal`) |
| `src/app/googDevice/client/DeviceTracker.ts` | Modify | Intercept shell link click → open ShellModal instead of navigating |
| `src/app/googDevice/client/ShellClient.ts` | No change | Full-page route preserved for direct URL access |
| `src/server/goog-device/mw/RemoteShell.ts` | No change | Server unchanged |

---

### Task 1: Add shell-specific modal CSS

**Files:**
- Modify: `src/style/dialog.css`

- [ ] **Step 1: Add shell modal size overrides**

Add at the end of `src/style/dialog.css`, before any final comment:

```css
/* ── Shell modal overrides ── */
.dialog-container.shell-modal {
    width: clamp(500px, 70vw, 900px);
    max-height: 90vh;
}

.dialog-container.shell-modal .dialog-body {
    padding: 0;
    background: #000;
    min-height: 300px;
}

.dialog-container.shell-modal .terminal-container {
    width: 100%;
    height: 100%;
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build:dev`
Expected: Compiles successfully.

- [ ] **Step 3: Commit**

```bash
git add src/style/dialog.css
git commit -m "style: add shell modal sizing overrides"
```

---

### Task 2: Create ShellModal class

**Files:**
- Create: `src/app/googDevice/client/ShellModal.ts`

This class creates the modal, opens a multiplexed WebSocket, instantiates xterm.js, and manages the lifecycle. It reuses the same WebSocket multiplexing infrastructure as ShellClient but without inheriting from ManagerClient/BaseClient.

- [ ] **Step 1: Create ShellModal.ts**

Create `src/app/googDevice/client/ShellModal.ts` with this content:

```typescript
import '@xterm/xterm/css/xterm.css';
import '../../../style/dialog.css';
import { AttachAddon } from '@xterm/addon-attach';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { ACTION } from '../../../common/Action';
import { ChannelCode } from '../../../common/ChannelCode';
import type { MessageXtermClient } from '../../../types/MessageXtermClient';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ManagerClient } from '../../client/ManagerClient';

export class ShellModal {
    private background: HTMLElement;
    private term?: Terminal;
    private fitAddon?: FitAddon;
    private ws?: Multiplexer | WebSocket;
    private resizeHandler?: () => void;

    constructor(
        private readonly udid: string,
        private readonly deviceName: string,
        private readonly params: { hostname?: string; port?: number; secure?: boolean; pathname?: string },
    ) {
        this.background = this.createUI();
        this.connect();
    }

    private createUI(): HTMLElement {
        // Backdrop
        const background = document.createElement('div');
        background.classList.add('dialog-background');

        // Container (shell-modal sizing)
        const container = document.createElement('div');
        container.classList.add('dialog-container', 'shell-modal');

        // Header
        const header = document.createElement('div');
        header.classList.add('dialog-header');
        const title = document.createElement('span');
        title.classList.add('dialog-title');
        title.textContent = this.deviceName;
        header.appendChild(title);
        const closeBtn = document.createElement('button');
        closeBtn.classList.add('close-btn');
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', this.close);
        header.appendChild(closeBtn);

        // Body (terminal container)
        const body = document.createElement('div');
        body.classList.add('dialog-body');
        const termContainer = document.createElement('div');
        termContainer.classList.add('terminal-container');
        body.appendChild(termContainer);

        // Assemble
        container.appendChild(header);
        container.appendChild(body);
        background.appendChild(container);
        // No backdrop click dismiss — only X button closes shell
        document.body.appendChild(background);
        return background;
    }

    private connect(): void {
        const { hostname, port, secure, pathname } = this.params;
        const resolvedHostname = hostname || window.location.hostname;
        const resolvedPort = port || Number.parseInt(window.location.port, 10) || 80;
        const protocol = secure ? 'wss:' : 'ws:';
        const resolvedPathname = pathname ?? location.pathname;
        const url = new URL(`${protocol}//${resolvedHostname}:${resolvedPort}${resolvedPathname}`);
        url.searchParams.set('action', ACTION.MULTIPLEX);
        const urlString = url.toString();

        // Reuse existing multiplexer if available, or create new one
        let multiplexer = ManagerClient.sockets.get(urlString);
        if (!multiplexer) {
            const ws = new WebSocket(urlString);
            ws.addEventListener('close', () => {
                ManagerClient.sockets.delete(urlString);
            });
            multiplexer = Multiplexer.wrap(ws);
            multiplexer.on('empty', () => {
                multiplexer!.close();
            });
            ManagerClient.sockets.set(urlString, multiplexer);
        }

        const channelData = new TextEncoder().encode(ChannelCode.SHEL);
        const channel = multiplexer.createChannel(channelData);
        this.ws = channel;

        channel.addEventListener('open', () => {
            this.initTerminal();
            this.startShell();
        });
        channel.addEventListener('close', () => {
            this.term?.dispose();
        });
    }

    private initTerminal(): void {
        if (!this.ws) return;
        const termContainer = this.background.querySelector('.terminal-container') as HTMLElement;
        if (!termContainer) return;

        this.term = new Terminal();
        this.term.loadAddon(new AttachAddon(this.ws));
        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.term.open(termContainer);
        this.fitAddon.fit();
        this.term.focus();

        // Re-fit on window resize
        this.resizeHandler = () => this.fitAddon?.fit();
        window.addEventListener('resize', this.resizeHandler);
    }

    private startShell(): void {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN || !this.fitAddon) return;
        const dims = this.fitAddon.proposeDimensions();
        if (!dims) return;
        const message: MessageXtermClient = {
            id: 1,
            type: 'shell',
            data: {
                type: 'start',
                rows: dims.rows,
                cols: dims.cols,
                udid: this.udid,
            },
        };
        this.ws.send(JSON.stringify(message));
    }

    private close = (): void => {
        // Send stop message
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            const message: MessageXtermClient = {
                id: 1,
                type: 'shell',
                data: { type: 'stop' } as any,
            };
            this.ws.send(JSON.stringify(message));
            this.ws.close();
        }
        // Cleanup terminal
        this.term?.dispose();
        // Remove resize listener
        if (this.resizeHandler) {
            window.removeEventListener('resize', this.resizeHandler);
        }
        // Remove modal from DOM
        document.body.removeChild(this.background);
    };
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build:dev`
Expected: Compiles successfully. The class is created but not yet wired up — no way to open it yet.

- [ ] **Step 3: Commit**

```bash
git add src/app/googDevice/client/ShellModal.ts
git commit -m "feat: add ShellModal class for terminal in glassmorphism overlay"
```

---

### Task 3: Intercept shell link clicks in DeviceTracker

**Files:**
- Modify: `src/app/googDevice/client/DeviceTracker.ts`

Change the shell link from a navigation link to a click handler that opens ShellModal.

- [ ] **Step 1: Add ShellModal import**

At the top of `src/app/googDevice/client/DeviceTracker.ts`, add the import:

```typescript
import { ShellModal } from './ShellModal';
```

- [ ] **Step 2: Find where tools create entries and intercept shell**

In `buildDeviceRow()`, after the tools loop that appends entries to the overlay section, we need to find shell entries and replace their navigation behavior. The shell entry is created by `ShellClient.createEntryForDeviceList()` which returns a div containing an anchor with `target="_blank"`.

Instead of modifying the tool registration system, intercept after the tools are appended. After the `DeviceTracker.tools.forEach(...)` block (around the line that loops tools), add code to find shell links and replace them.

Find the block:
```typescript
        DeviceTracker.tools.forEach((tool) => {
            const entry = tool.createEntryForDeviceList(device, 'desc-block', this.params);
            if (entry) {
                if (Array.isArray(entry)) {
                    entry.forEach((item) => {
                        item && overlaySection.appendChild(item);
                    });
                } else {
                    overlaySection.appendChild(entry);
                }
            }
        });
```

After this block, add:
```typescript
        // Intercept shell links — open modal instead of navigating to new tab
        const shellLink = overlaySection.querySelector('.shell a') as HTMLAnchorElement | null;
        if (shellLink) {
            shellLink.removeAttribute('target');
            shellLink.addEventListener('click', (e) => {
                e.preventDefault();
                new ShellModal(device.udid, device['ro.product.model'] || device.udid, this.params);
            });
        }
```

- [ ] **Step 3: Build and verify**

Run: `npm run build:dev`
Expected: Compiles successfully.

- [ ] **Step 4: Restart server and test in browser**

Kill the running server, start it fresh. Open http://localhost:8000, click "shell" on a device card. Verify:
- Modal appears centered with dimmed backdrop (no blur)
- Device name in header, X button in top-right
- Terminal loads and shows ADB shell prompt
- Terminal accepts input (type `ls`, press Enter)
- Backdrop click does NOT close the modal
- Escape key is passed to terminal (does NOT close modal)
- X button closes modal and kills terminal session
- Window resize re-fits terminal dimensions
- Can open shell modal for a different device after closing

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All 46 tests passing. No test changes needed.

- [ ] **Step 6: Commit**

```bash
git add src/app/googDevice/client/DeviceTracker.ts
git commit -m "feat: intercept shell link clicks to open ShellModal overlay"
```

---

### Task 4: Push and update docs

**Files:**
- Modify: `docs/TECHNICAL_GUIDE.md` (minor reference update)

- [ ] **Step 1: Update technical guide**

In section 14.1, the shell is listed as opening in a new tab. Update the "opens in overlay" section entry for shell to note it now opens in a modal overlay.

- [ ] **Step 2: Push all commits**

```bash
git push
```

- [ ] **Step 3: Verify clean state**

```bash
git status
git log --oneline -5
```

Expected: Clean working tree, up to date with remote.
