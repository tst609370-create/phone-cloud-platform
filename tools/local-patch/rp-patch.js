/* 添加模拟器 / 云手机（本机补丁版）：只用已有接口 /api/devices/connect、/api/devices/labels，
   地址列表存服务器（labels 表的 KEY 项）+ 本机 localStorage；控制台开着时每 20 秒把掉线的重新 adb connect。 */
(() => {
    if (window.__remoteDevicesPatch || document.getElementById('add-device')) return;
    window.__remoteDevicesPatch = true;
    const KEY = 'phonecloud-remote-devices';
    const PORTS = [[5555, 'BlueStacks'], [5565, 'BlueStacks 2'], [5575, 'BlueStacks 3'], [5585, 'BlueStacks 4'], [7555, 'MuMu'], [16384, 'MuMu 12'], [16416, 'MuMu 12 #2'], [5557, '雷电 #2'], [62001, '夜神'], [62025, '夜神 #2'], [21503, '逍遥']];
    const toast = (t, tone = 'info') => (window.TX ? window.TX.toast(t, tone) : console.log(t));
    const norm = (s) => {
        let t = String(s || '').trim().replace(/^adb\s+connect\s+/i, '');
        if (!t) return null;
        if (!t.includes(':')) t += ':5555';
        const m = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(t);
        return m && +m[2] > 0 && +m[2] < 65536 ? `${m[1].toLowerCase()}:${+m[2]}` : null;
    };
    let list = [];
    try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { list = []; }
    async function loadList() {
        try {
            const r = await fetch('/api/devices/labels', { cache: 'no-store' });
            if (r.ok) {
                const labels = await r.json();
                const raw = Array.isArray(labels) ? labels.find((l) => l.serial === KEY)?.label : labels?.[KEY];
                if (raw) list = JSON.parse(raw);
            }
        } catch { /* 用本机缓存 */ }
        list = Array.isArray(list) ? list.filter((d) => norm(d.address)) : [];
    }
    async function saveList() {
        try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
        try {
            await fetch('/api/devices/labels', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serial: KEY, label: list.length ? JSON.stringify(list) : '' }) });
        } catch { /* ignore */ }
    }
    async function adbConnect(address) {
        try {
            const r = await fetch('/api/devices/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
            const j = await r.json().catch(() => ({}));
            return { ok: !!j.success, msg: j.message || j.error || `HTTP ${r.status}` };
        } catch (e) { return { ok: false, msg: e.message }; }
    }
    async function connectedSerials() {
        try {
            const r = await fetch('/api/devices/connected', { cache: 'no-store' });
            return new Set(r.ok ? (await r.json()).map((d) => d.serial) : []);
        } catch { return new Set(); }
    }
    let ticking = false;
    async function reconnectTick() {
        if (ticking || !list.length) return;
        ticking = true;
        try {
            const have = await connectedSerials();
            for (const d of list) if (!have.has(d.address)) await adbConnect(d.address);
        } finally { ticking = false; }
    }

    const css = document.createElement('style');
    css.textContent = `
.add-device{height:32px;padding:0 8px;display:flex;align-items:center;gap:8px;border:0;border-radius:var(--tx-radius-md,8px);color:var(--tx-fg-3,#999);background:transparent;font-size:var(--tx-text-sub,13px);text-align:left;cursor:pointer;width:100%}
.add-device[hidden]{display:none}.add-device svg{width:14px;height:14px}.add-device:hover{color:var(--tx-fg,#fff);background:var(--tx-wash-3,rgba(255,255,255,.06))}
.rd-dialog{width:min(520px,calc(100vw - 28px));padding:0;color:var(--tx-fg,#eee);border:1px solid var(--tx-line-strong,#333);border-radius:12px;background:var(--tx-surface-2,#16171a)}
.rd-dialog::backdrop{background:rgba(0,0,0,.6);backdrop-filter:blur(4px)}
.rd-dialog header{padding:16px;display:flex;align-items:flex-start;border-bottom:1px solid var(--tx-line,#262626)}
.rd-dialog header div{display:grid;gap:4px}.rd-dialog header strong{font-size:16px}.rd-dialog header small{color:var(--tx-fg-3,#999)}
.rd-dialog header button{margin-left:auto;border:0;background:transparent;color:var(--tx-fg-3,#999);font-size:18px;cursor:pointer}
.rd-form{padding:12px 10px 2px;display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto;gap:6px}
.rd-form input{min-width:0;height:32px;padding:0 10px;border:1px solid var(--tx-line,#333);border-radius:8px;outline:0;color:inherit;background:var(--tx-field,#0f1012)}
.rd-list{min-height:120px;max-height:50vh;padding:10px;overflow:auto;display:grid;align-content:start;gap:6px}
.rd-list>p{margin:30px 12px;color:var(--tx-fg-3,#999);text-align:center}
.rd-item{padding:10px 12px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;border:1px solid var(--tx-line,#262626);border-radius:10px;background:var(--tx-surface,#121315)}
.rd-item div{display:grid;gap:2px}.rd-item small{color:var(--tx-fg-4,#777);font:11px/1.4 monospace}.rd-ok{color:#3ecf8e!important}.rd-bad{color:#f2555a!important}
.rd-btn{height:30px;padding:0 12px;border:1px solid transparent;border-radius:8px;color:#08090a;background:#f7f8f8;cursor:pointer}.rd-btn.sec{color:inherit;background:transparent;border-color:rgba(255,255,255,.15)}.rd-btn:disabled{opacity:.5;cursor:wait}
.rd-dialog footer{padding:12px;border-top:1px solid var(--tx-line,#262626)}.rd-dialog footer .rd-btn{width:100%;height:36px}`;
    document.head.appendChild(css);

    const button = document.createElement('button');
    button.id = 'add-device';
    button.type = 'button';
    button.className = 'add-device sidebar-label';
    button.hidden = true;
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>添加模拟器 / 云手机</span>';
    const nav = document.querySelector('.device-nav');
    if (nav) nav.after(button); else document.querySelector('.sidebar')?.appendChild(button);

    const dlg = document.createElement('dialog');
    dlg.className = 'rd-dialog';
    dlg.innerHTML = `<header><div><strong>添加模拟器 / 云手机</strong><small>填 ADB 地址（IP:端口）。控制台开着时，掉线的每 20 秒自动重连</small></div><button type="button" data-close>×</button></header>
<form class="rd-form" autocomplete="off"><input name="a" placeholder="127.0.0.1:5555 或 云手机IP:端口" required><input name="l" placeholder="备注（可选）" maxlength="40"><button class="rd-btn" type="submit">添加</button></form>
<div class="rd-list"></div><footer><button type="button" class="rd-btn sec" data-scan>扫描本机模拟器（BlueStacks / MuMu / 雷电 / 夜神 / 逍遥）</button></footer>`;
    document.body.appendChild(dlg);
    const box = dlg.querySelector('.rd-list');
    const msg = (t) => { box.innerHTML = ''; const p = document.createElement('p'); p.textContent = t; box.appendChild(p); };
    const item = (title, sub, state, cls, btn) => {
        const el = document.createElement('div');
        el.className = 'rd-item';
        const info = document.createElement('div');
        const s = document.createElement('strong'); s.textContent = title;
        const a = document.createElement('small'); a.textContent = sub;
        const b = document.createElement('small'); b.textContent = state; if (cls) b.className = cls;
        info.append(s, a, b);
        el.append(info, btn);
        return el;
    };
    async function render() {
        if (!list.length) return msg('还没有添加。BlueStacks 先在 设置 → 高级 里打开「Android 调试桥（ADB）」，再点下方扫描，或直接填 127.0.0.1:5555。');
        const have = await connectedSerials();
        box.innerHTML = '';
        for (const d of list) {
            const del = document.createElement('button');
            del.className = 'rd-btn sec'; del.type = 'button'; del.textContent = '删除';
            del.onclick = async () => {
                del.disabled = true;
                list = list.filter((x) => x.address !== d.address);
                await saveList();
                fetch('/api/devices/disconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: d.address }) }).catch(() => {});
                toast('已删除', 'ok');
                render();
            };
            const ok = have.has(d.address);
            box.appendChild(item(d.label || d.address, d.label ? d.address : 'ADB 网络设备', ok ? '已连接' : '未连接，自动重试中', ok ? 'rd-ok' : 'rd-bad', del));
        }
    }
    async function add(address, label) {
        const a = norm(address);
        if (!a) return toast('地址格式不对，应为 IP:端口，例如 127.0.0.1:5555', 'err');
        const old = list.find((d) => d.address === a);
        if (old) old.label = label || old.label; else list.push({ address: a, label: label || '' });
        await saveList();
        const r = await adbConnect(a);
        toast(r.ok ? `${a} 已连接，几秒后出现在设备列表` : `已保存 ${a}，暂时连不上：${r.msg}。会自动重试`, r.ok ? 'ok' : 'err');
        render();
    }
    dlg.querySelector('[data-close]').onclick = () => dlg.close();
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target; const sb = f.querySelector('button'); sb.disabled = true;
        try { await add(f.a.value, f.l.value.trim()); f.reset(); } finally { sb.disabled = false; }
    };
    dlg.querySelector('[data-scan]').onclick = async (e) => {
        const b = e.currentTarget; b.disabled = true;
        msg('正在扫描本机模拟器端口（约 10 秒）…');
        try {
            const found = [];
            await Promise.all(PORTS.map(async ([port, name]) => {
                const address = `127.0.0.1:${port}`;
                const r = await adbConnect(address);
                if (r.ok) found.push({ address, name });
            }));
            if (!found.length) return msg('没扫到开着 ADB 的模拟器。请确认模拟器已启动，并在模拟器设置里打开 ADB 调试（BlueStacks：设置 → 高级 → Android 调试桥），也可以直接填地址。');
            let added = 0;
            for (const f of found) if (!list.some((d) => d.address === f.address)) { list.push({ address: f.address, label: f.name }); added++; }
            await saveList();
            toast(`找到 ${found.length} 个模拟器，已全部添加${added ? '' : '（之前已添加过）'}`, 'ok');
            render();
        } finally { b.disabled = false; }
    };
    button.onclick = async () => { dlg.showModal(); msg('正在读取…'); await loadList(); render(); };

    (async () => {
        try {
            const me = await (await fetch('/api/auth/me', { cache: 'no-store' })).json();
            if (me.user?.role !== 'admin') return;
        } catch { return; }
        button.hidden = false;
        await loadList();
        reconnectTick();
        setInterval(async () => { await loadList(); reconnectTick(); }, 20000);
    })();
})();

/* 卡片按钮挂到画面右侧：把标题栏里的主/跟、开麦克风、听声音、功能、+ 和底部 返回/主页/多任务/截图/锁屏 移到右侧一条竖栏 */
(() => {
    if (window.__sideToolsPatch) return;
    window.__sideToolsPatch = true;
    const css = document.createElement('style');
    css.textContent = `
.phone-card.rp-side{grid-template-columns:minmax(0,1fr) 62px!important;grid-template-rows:36px minmax(0,1fr) 22px!important}
.phone-card.rp-side>header{grid-column:1/-1;grid-row:1}
.phone-card.rp-side>iframe,.phone-card.rp-side>.last-frame,.phone-card.rp-side>.preview-shield,.phone-card.rp-side>.stream-hint,.phone-card.rp-side>.native-input-layer{grid-column:1!important;grid-row:2!important}
.phone-card.rp-side>.card-operation-log{grid-column:1/-1;grid-row:3}
.phone-card.rp-side>.resume-stream{right:62px!important}
.phone-card.rp-side.closed .rp-tools{display:none}
.rp-tools{grid-column:2;grid-row:2;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:6px 5px;border-left:1px solid var(--tx-line,#262626);background:var(--tx-surface,#121315);scrollbar-width:none}
.rp-tools::-webkit-scrollbar{display:none}
.rp-tools .sync-controls{margin:0!important;display:flex;justify-content:center;gap:3px}
.rp-tools .card-actions,.rp-tools .phone-nav{margin:0!important;display:flex!important;flex-direction:column;gap:3px;width:100%;height:auto!important;min-height:0;padding:6px 0 0!important;border:0!important;border-top:1px solid var(--tx-line,#262626)!important;background:transparent!important;overflow:visible!important}
.rp-tools .card-actions button,.rp-tools .phone-nav button{width:100%;min-width:0;height:auto;min-height:30px;padding:3px 2px;display:grid;place-items:center;border:1px solid transparent;border-radius:6px;color:var(--tx-fg-2,#ccc);background:var(--tx-wash-2,rgba(255,255,255,.04));font-size:11px;line-height:1.25;white-space:normal;word-break:break-all;text-align:center}
.rp-tools button:hover{color:var(--tx-fg,#fff);border-color:var(--tx-line-strong,#333)}
.rp-tools .card-actions button.active,.rp-tools .card-actions button[aria-pressed="true"]{color:var(--tx-bg,#08090a);background:var(--tx-fg,#f7f8f8)}
.rp-tools [data-action="fullscreen"],.rp-tools [data-action="close"]{display:none!important}
.phone-card.rp-side header strong{max-width:none!important}
.phone-card.rp-side:not(.expanded){min-width:0!important}
.phone-card.rp-side>iframe{width:100%!important;height:100%!important}
.phone-card.rp-side{border:0!important;box-shadow:none!important;outline:0!important;border-radius:8px!important;background:#000!important}
.phone-card.rp-side>iframe,.phone-card.rp-side>.last-frame{border:0!important;margin:0!important;padding:0!important;display:block}
.rp-tools{border-left:0!important}
.rp-toggle{margin-left:auto;width:24px;height:24px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;color:var(--tx-fg-3,#999);background:transparent;cursor:pointer;font-size:14px;line-height:1}
.rp-toggle:hover{color:var(--tx-fg,#fff);background:var(--tx-wash-4,rgba(255,255,255,.08))}
html.rp-hide-tools .phone-card.rp-side{grid-template-columns:minmax(0,1fr)!important}
html.rp-hide-tools .rp-tools{display:none!important}
html.rp-hide-tools .phone-card.rp-side>.resume-stream{right:0!important}`;
    document.head.appendChild(css);
    function apply(card) {
        if (!card || card.classList.contains('rp-side')) return;
        const header = card.querySelector(':scope > header');
        const sync = header?.querySelector('.sync-controls');
        const actions = header?.querySelector('.card-actions');
        const nav = card.querySelector(':scope > .phone-nav');
        if (!actions && !nav) return;
        const tools = document.createElement('div');
        tools.className = 'rp-tools';
        if (sync) tools.appendChild(sync);
        if (actions) tools.appendChild(actions);
        if (nav) tools.appendChild(nav);
        card.appendChild(tools);
        card.classList.add('rp-side');
        if (header && !header.querySelector('.rp-toggle')) {
            const t = document.createElement('button');
            t.type = 'button';
            t.className = 'rp-toggle';
            const paint = () => { const h = document.documentElement.classList.contains('rp-hide-tools'); t.textContent = h ? '‹' : '›'; t.title = h ? '显示按钮' : '隐藏按钮（全部窗口）'; };
            paint();
            t.addEventListener('click', (e) => {
                e.stopPropagation();
                const hide = !document.documentElement.classList.contains('rp-hide-tools');
                document.documentElement.classList.toggle('rp-hide-tools', hide);
                try { localStorage.setItem('rp-hide-tools', hide ? '1' : '0'); } catch { /* ignore */ }
                document.querySelectorAll('.rp-toggle').forEach((b) => b._paint?.());
                document.querySelectorAll('.phone-card.rp-side').forEach(fit);
            });
            t._paint = paint;
            t.addEventListener('mousedown', (e) => e.stopPropagation());
            header.appendChild(t);
        }
    }
    // 窗口大小跟画面比例走：画面宽 = 窗口大小档（小/中/大），右侧加 62px 工具栏，高度 = 标题栏 + 画面 + 状态行，不留黑边
    try { if (localStorage.getItem('rp-hide-tools') === '1') document.documentElement.classList.add('rp-hide-tools'); } catch { /* ignore */ }
    // 画面铺满 iframe：去掉内嵌页的留白，画面与 touch 层同尺寸拉满（窗口已按画面比例，拉伸可忽略）
    const INNER_CSS = 'html,body{margin:0!important;padding:0!important;overflow:hidden!important;background:#000!important}'
        + '.device-view,.video{width:100vw!important;height:100vh!important;margin:0!important;padding:0!important}'
        + '.video-layer,.touch-layer{width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important}';
    function fillInner(card) {
        try {
            const doc = card.querySelector('iframe')?.contentDocument;
            if (!doc?.head || doc.getElementById('rp-inner')) return;
            const st = doc.createElement('style');
            st.id = 'rp-inner';
            st.textContent = INNER_CSS;
            doc.head.appendChild(st);
        } catch { /* cross-origin or navigating */ }
    }
    const toolW = () => (document.documentElement.classList.contains('rp-hide-tools') ? 0 : 62);
    function ratioOf(card) {
        const m = /(\d+)\s*[×x]\s*(\d+)/.exec(card.querySelector('.card-operation-log')?.dataset.stream || '');
        if (m && +m[1] && +m[2]) return +m[1] / +m[2];
        try {
            const c = card.querySelector('iframe')?.contentDocument?.querySelector('.touch-layer');
            if (c && c.width && c.height) return c.width / c.height;
        } catch { /* ignore */ }
        if (typeof card._lastAspect === 'number' && card._lastAspect > 0) return card._lastAspect;
        const img = card.querySelector('.last-frame');
        if (img?.naturalWidth && img.naturalHeight) return img.naturalWidth / img.naturalHeight;
        return 0;
    }
    function fit(card) {
        if (!card.classList.contains('rp-side') || card.classList.contains('expanded') || card.classList.contains('closed')) return;
        fillInner(card);
        const ratio = ratioOf(card);
        if (!ratio) return;
        const border = 0;
        const headerH = card.querySelector(':scope > header')?.offsetHeight || 36;
        const logH = card.querySelector(':scope > .card-operation-log')?.offsetHeight || 22;
        const tile = Number(document.getElementById('tile-size')?.value) || 400;
        let picW = Math.max(120, tile - border);
        let picH = picW / ratio;
        const maxH = Math.max(200, innerHeight - 90 - headerH - logH - border);
        if (picH > maxH) { picH = maxH; picW = picH * ratio; }
        const w = Math.round(picW + toolW() + border);
        const h = Math.round(picH + headerH + logH + border);
        if (!(Math.abs(parseFloat(card.style.width) - w) <= 1)) card.style.width = `${w}px`;
        if (!(Math.abs(parseFloat(card.style.height) - h) <= 1)) card.style.height = `${h}px`;
    }
    const styleWatch = new MutationObserver((records) => {
        for (const r of records) fit(r.target);
    });
    const scan = () => document.querySelectorAll('.phone-card').forEach((card) => {
        const fresh = !card.classList.contains('rp-side');
        apply(card);
        if (fresh && card.classList.contains('rp-side')) styleWatch.observe(card, { attributes: true, attributeFilter: ['style', 'class'] });
        fit(card);
    });
    scan();
    setInterval(() => document.querySelectorAll('.phone-card.rp-side').forEach(fit), 1500);
    addEventListener('resize', () => setTimeout(() => document.querySelectorAll('.phone-card.rp-side').forEach(fit), 50));
    const grid = document.getElementById('phone-grid');
    new MutationObserver(scan).observe(grid || document.body, { childList: true, subtree: !grid });
})();
