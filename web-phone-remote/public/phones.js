(() => {
    const app = document.querySelector('.app');
    let cards = [];
    const quality = document.getElementById('quality');
    const fps = document.getElementById('fps');
    const tileSize = document.getElementById('tile-size');
    const UI_VERSION = '1113z6';
    const sizeValue = document.getElementById('size-value');
    const backdrop = document.getElementById('viewer-backdrop');
    const grid = document.getElementById('phone-grid');
    const syncToggle = document.getElementById('sync-toggle');
    const mobilePicker = document.getElementById('mobile-device-picker');
    const workspace = document.querySelector('.workspace');
    const videoModeButton = document.getElementById('stream-video');
    const snapshotModeButton = document.getElementById('stream-snapshot');
    const layoutVersion = '20260822j';
    let topLayer = 10;
    let layoutTimer = 0;
    let needsInitialLayout = localStorage.getItem('phone-layout-version') !== layoutVersion;
    let syncEnabled = localStorage.getItem('phone-sync-enabled') === '1';
    let masterSerial = localStorage.getItem('phone-sync-master') || '';
    let activeSerial = localStorage.getItem('phone-active-device') || '';
    // 每次打开都从流畅视频开始：抽帧远控帧率低，租用者不知道会以为操作卡。
    let streamMode = 'video';
    let visibleDevices = [];
    let rentalByDevice = new Map();
    let rentalSignature = '';
    const desktopKeyboard = window.matchMedia?.('(any-hover: hover) and (any-pointer: fine)').matches ?? false;
    const nativeMacShell = new URLSearchParams(location.search).get('native') === 'mac'
        || localStorage.getItem('phone-native-shell') === 'mac';
    if (new URLSearchParams(location.search).get('native') === 'mac') {
        localStorage.setItem('phone-native-shell', 'mac');
    }
    const autoArrange = true;
    if (nativeMacShell) {
        document.getElementById('reconnect-all').hidden = true;
        document.getElementById('expand-first').hidden = true;
        document.getElementById('refresh-page').hidden = false;
    }

    // Tianxi UI：提示用 Toast（tianxi.js），图标用 lucide 线稿
    const notify = (text, tone = 'info', duration) => (window.TX ? window.TX.toast(text, tone, duration) : console.warn(text));
    const svgIcon = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    const CARD_ICONS = {
        upload: svgIcon('<path d="M12 5v14M5 12h14"/>'),
        reconnect: svgIcon('<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>'),
        fullscreen: svgIcon('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'),
        close: svgIcon('<path d="M18 6 6 18M6 6l12 12"/>'),
    };

    const chineseDeviceNames = {
        HD1925: '一加 7T Pro 迈凯伦',
        'Pixel 8': '谷歌 Pixel 8',
        A101BM: '巴慕达 Phone',
        CPH2211: 'OPPO Find X3 Pro',
        'SM-F926B': '三星 Galaxy Z Fold3',
    };

    function deviceName(device) {
        const name = device.label || device.model || device.serial;
        return localStorage.getItem(`phone-device-note:${device.serial}`) || chineseDeviceNames[name] || chineseDeviceNames[device.model] || name;
    }

    function logOperation(card, label) {
        const now = Date.now();
        const status = card.querySelector('.card-operation-log');
        if (!status) return;
        const time = new Date(now).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        status.dataset.label = label;
        status.dataset.at = String(now);
        status.textContent = `${time}  ${label}`;
        status.title = status.textContent;
    }

    function activeCard() {
        return cards.find((item) => item.dataset.device === activeSerial && !item.classList.contains('closed'))
            || cards.find((item) => !item.classList.contains('closed'));
    }

    function formatFileSize(bytes) {
        if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Number(bytes) || 0)} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    async function installLibraryApp(card, apk, button) {
        button.disabled = true;
        button.textContent = '安装中…';
        setState(card, '', '正在安装');
        logOperation(card, `正在安装 ${apk.name}`);
        try {
            const response = await fetch('/api/apks/install', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: apk.name, devices: [card.dataset.device] }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.results?.[0]?.ok) throw new Error(result.results?.[0]?.error || result.error || '安装失败');
            button.textContent = '已安装';
            setState(card, 'connected', '安装完成');
            logOperation(card, `已安装 ${apk.name}`);
        } catch (error) {
            button.disabled = false;
            button.textContent = '重新安装';
            setState(card, 'error', '安装失败');
            logOperation(card, error instanceof Error ? error.message : '安装失败');
        }
    }

    /** Install one library APK on every phone in the list; say per phone what happened. */
    async function installLibraryAppAll(apk, button) {
        const devices = visibleDevices.map((device) => device.serial).slice(0, 50);
        if (!devices.length) return;
        button.disabled = true;
        button.textContent = `安装中…（${devices.length} 台）`;
        const sound = /^PhoneSound/i.test(apk.name);
        try {
            const response = await fetch(sound ? '/api/apks/install-sound' : '/api/apks/install', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(sound ? { devices } : { name: apk.name, devices }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok && !result.results) throw new Error(result.error || '安装失败');
            const results = result.results || [];
            const okCount = results.filter((item) => item.ok).length;
            for (const item of results) {
                const card = cards.find((c) => c.dataset.device === item.serial);
                if (card) logOperation(card, item.ok ? `已安装 ${apk.name}` : `${apk.name} 安装失败：${item.error || '未知原因'}`);
            }
            const failed = results.filter((item) => !item.ok);
            button.textContent = failed.length ? `成功 ${okCount} 台，失败 ${failed.length} 台` : `全部 ${okCount} 台已安装`;
            notify(
                failed.length
                    ? `${apk.name}：${okCount} 台成功，${failed.length} 台失败。${failed.map((item) => `${deviceLabel(item.serial)}：${item.error || '未知原因'}`).join('；')}`
                    : `${apk.name} 已装到 ${okCount} 台手机${sound ? '，点「听声音」或重连即可' : ''}`,
                failed.length ? 'err' : 'ok',
                failed.length ? 12000 : 4000,
            );
        } catch (error) {
            button.textContent = '安装到全部手机';
            notify(error instanceof Error ? error.message : '安装失败', 'err');
        } finally {
            button.disabled = false;
        }
    }

    function deviceLabel(serial) {
        return cards.find((c) => c.dataset.device === serial)?.dataset.name || serial;
    }

    async function loadAppLibrary() {
        const dialog = document.getElementById('app-library');
        const list = document.getElementById('app-library-list');
        const target = document.getElementById('app-library-target');
        const card = activeCard();
        target.textContent = card?.dataset.name || '无可用云机';
        list.replaceChildren();
        const loading = document.createElement('p');
        loading.textContent = '正在读取软件列表…';
        list.appendChild(loading);
        try {
            const response = await fetch('/api/apks', { cache: 'no-store' });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || '软件列表读取失败');
            list.replaceChildren();
            if (!result.apks?.length) {
                const empty = document.createElement('p');
                empty.textContent = '软件库暂无安装包，请管理员先在后台上传。';
                list.appendChild(empty);
                return;
            }
            for (const apk of result.apks) {
                const item = document.createElement('article');
                item.className = 'app-library-item';
                const info = document.createElement('div');
                const name = document.createElement('strong');
                name.textContent = apk.name;
                name.title = apk.name;
                const meta = document.createElement('small');
                meta.textContent = `${formatFileSize(apk.size)} · ${new Date(apk.modifiedAt).toLocaleString('zh-CN', { hour12: false })}`;
                info.append(name, meta);
                const install = document.createElement('button');
                install.type = 'button';
                install.textContent = '安装';
                install.disabled = !card;
                install.addEventListener('click', () => void installLibraryApp(card, apk, install));
                const installAll = document.createElement('button');
                installAll.type = 'button';
                installAll.className = 'install-all';
                installAll.textContent = '安装到全部手机';
                installAll.disabled = !visibleDevices.length;
                installAll.addEventListener('click', () => void installLibraryAppAll(apk, installAll));
                const buttons = document.createElement('span');
                buttons.className = 'app-library-buttons';
                buttons.append(install, installAll);
                item.append(info, buttons);
                list.appendChild(item);
            }
        } catch (error) {
            list.replaceChildren();
            const failure = document.createElement('p');
            failure.textContent = error instanceof Error ? error.message : '软件列表读取失败';
            list.appendChild(failure);
        }
        if (!dialog.open) dialog.showModal();
    }

    function rentalLabel(rental) {
        if (!rental) return '';
        if (rental.expired) return `已到期·${rental.label}`;
        if (rental.disabled) return `已停用·${rental.label}`;
        return `租·${rental.label}`;
    }

    function applyRentalBadges() {
        cards.forEach((card) => {
            const rental = rentalByDevice.get(card.dataset.device);
            const badge = card.querySelector('.rental-badge');
            if (!badge) return;
            badge.hidden = !rental;
            badge.textContent = rentalLabel(rental);
            badge.title = rental ? `${rental.label} · ${rental.expiresAt ? new Date(rental.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '永久有效'}` : '';
            badge.classList.toggle('expired', Boolean(rental?.expired || rental?.disabled));
        });
        if (visibleDevices.length) renderDeviceNav(visibleDevices);
    }

    function createCard(device, index) {
        const name = deviceName(device);
        const card = document.createElement('article');
        card.className = 'phone-card';
        card.dataset.device = device.serial;
        card.dataset.name = name;
        card.dataset.deviceKind = device.deviceKind || 'phone';

        const header = document.createElement('header');
        const number = document.createElement('span');
        number.className = 'device-number';
        number.textContent = String(index + 1);
        const title = document.createElement('strong');
        title.textContent = name;
        const state = document.createElement('span');
        state.className = 'connection-state';
        state.textContent = '连接中';
        const rentalBadge = document.createElement('span');
        rentalBadge.className = 'rental-badge';
        rentalBadge.hidden = true;
        const syncControls = document.createElement('span');
        syncControls.className = 'sync-controls';
        const masterLabel = document.createElement('label');
        masterLabel.title = '设为主控手机';
        const master = document.createElement('input');
        master.type = 'radio';
        master.name = 'sync-master';
        master.className = 'sync-master';
        master.checked = masterSerial ? device.serial === masterSerial : index === 0;
        masterLabel.append(master, Object.assign(document.createElement('span'), { textContent: '主' }));
        const followerLabel = document.createElement('label');
        followerLabel.title = '跟随主控手机';
        const follower = document.createElement('input');
        follower.type = 'checkbox';
        follower.className = 'sync-target';
        const savedFollower = localStorage.getItem(`phone-sync-target:${device.serial}`);
        follower.checked = savedFollower === null ? index > 0 : savedFollower === '1';
        followerLabel.append(follower, Object.assign(document.createElement('span'), { textContent: '跟' }));
        syncControls.append(masterLabel, followerLabel);
        const actions = document.createElement('span');
        actions.className = 'card-actions';
        for (const [action, label, icon] of [
            ['browser-mic', '当前手机的浏览器麦克风。点一下关闭后不会自动再开。和听手机播放的声音不是一回事。', '开麦克风'],
            ['hear', '听这部手机正在播放的声音。不需要 root，也不是麦克风注入。再点一次停止。', '听声音'],
            ['denoise', '降噪：去掉没 ROOT 的安卓 8-10 手机录外放时的底噪/电流声。点一下切换 标准 → 强 → 关。', '降噪'],
            ['tools', '展开功能', '功能'],
            ['upload', '安装 APP 或导入图片', CARD_ICONS.upload],
            ['reconnect', '重新连接', CARD_ICONS.reconnect],
            ['fullscreen', '放大操作', CARD_ICONS.fullscreen],
            ['close', '关闭', CARD_ICONS.close],
        ]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.action = action;
            button.title = label;
            if (icon.startsWith('<svg')) {
                button.innerHTML = icon;
                button.setAttribute('aria-label', label);
            } else {
                button.textContent = icon;
            }
            actions.appendChild(button);
        }
        const backToGrid = document.createElement('button');
        backToGrid.type = 'button';
        backToGrid.className = 'back-to-grid';
        backToGrid.title = '回到九宫格小窗（Esc 全部缩回）';
        backToGrid.setAttribute('aria-label', '回到九宫格');
        backToGrid.innerHTML = svgIcon('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>');
        backToGrid.addEventListener('click', () => collapseCard(card));
        header.append(backToGrid, number, title, state, rentalBadge, syncControls, actions);

        const frame = document.createElement('iframe');
        frame.title = `${name} 控制窗口`;
        frame.allow = 'autoplay; microphone; clipboard-read; clipboard-write; fullscreen';
        frame.src = 'about:blank';
        const nativeInput = document.createElement('div');
        nativeInput.className = 'native-input-layer';
        nativeInput.hidden = !nativeMacShell;
        const lastFrame = document.createElement('img');
        lastFrame.className = 'last-frame';
        lastFrame.alt = `${name} 最后一帧`;
        const resume = document.createElement('button');
        resume.type = 'button';
        resume.className = 'resume-stream';
        resume.textContent = '点击打开';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*,.apk';
        fileInput.multiple = true;
        fileInput.hidden = true;
        const phoneNav = document.createElement('nav');
        phoneNav.className = 'phone-nav';
        phoneNav.setAttribute('aria-label', '手机导航');
        for (const [title, label] of [
            ['返回', '返回'],
            ['主页', '主页'],
            ['多任务', '多任务'],
            ['截图', '截图'],
        ]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.title = title;
            button.textContent = label;
            button.addEventListener('click', () => pressPhoneButton(card, title));
            phoneNav.appendChild(button);
        }
        const screenLock = document.createElement('button');
        screenLock.type = 'button';
        screenLock.dataset.action = 'screen-lock';
        screenLock.title = '锁屏或解锁';
        screenLock.textContent = '锁屏';
        screenLock.addEventListener('click', () => void toggleDeviceScreenLock(card));
        phoneNav.appendChild(screenLock);
        const operationStatus = document.createElement('div');
        operationStatus.className = 'card-operation-log';
        operationStatus.setAttribute('aria-live', 'polite');
        operationStatus.textContent = '等待操作…';
        const shield = document.createElement('button');
        shield.type = 'button';
        shield.className = 'preview-shield';
        shield.setAttribute('aria-label', `放大操作 ${name}`);
        shield.innerHTML = '<span>点击放大操作</span>';
        shield.addEventListener('click', () => expand(card));
        // 放大动画结束后标题栏才是最终宽度，再按实际标题栏高度校正一次窗口高度。
        card.addEventListener('transitionend', (event) => {
            if (event.target === card && event.propertyName === 'width') sizeExpanded(card);
        });
        // 黑屏时在画面中间说清楚原因，而不是一片黑：息屏 → 点亮屏幕；没画面 → 重新连接。
        const hint = document.createElement('div');
        hint.className = 'stream-hint';
        hint.hidden = true;
        hint.innerHTML = '<p></p><div><button type="button" data-hint="wake">点亮屏幕</button><button type="button" data-hint="reconnect">重新连接</button></div>';
        hint.addEventListener('click', (event) => {
            const button = event.target.closest('button');
            if (!button) return;
            if (button.dataset.hint === 'reconnect') {
                logOperation(card, '没画面，重新连接');
                activate(card, true, true);
                return;
            }
            button.disabled = true;
            setDeviceScreenPower(card, true)
                .then(() => { card._awake = true; logOperation(card, '已点亮屏幕'); })
                .catch((error) => notify(error instanceof Error ? error.message : '点亮屏幕失败', 'err'))
                .finally(() => { button.disabled = false; });
        });
        card.append(header, lastFrame, frame, nativeInput, resume, shield, hint, phoneNav, operationStatus, fileInput);
        grid.appendChild(card);
        void refreshScreenLockButton(card);
        restorePosition(card, index);
        enableDragging(card);
        card.querySelector('[data-action="browser-mic"]').addEventListener('click', () => toggleBrowserMic(card));
        card.querySelector('[data-action="hear"]').addEventListener('click', () => toggleHear(card));
        card.querySelector('[data-action="denoise"]').addEventListener('click', () => cycleDenoise(card));
        paintDenoise(card);
        card.querySelector('[data-action="tools"]').addEventListener('click', () => {
            const open = card.classList.toggle('tools-open');
            card.querySelector('[data-action="tools"]').classList.toggle('active', open);
            card.querySelector('iframe').contentDocument?.body?.classList.toggle('tools-expanded', open);
            alignNativeInputLayer(card, card._nativeCanvas);
        });
        card.querySelector('[data-action="upload"]').addEventListener('click', () => fileInput.click());
        card.querySelector('[data-action="reconnect"]').addEventListener('click', () => activate(card, true, true));
        card.querySelector('[data-action="fullscreen"]').addEventListener('click', () => {
            if (card.classList.contains('expanded')) collapseCard(card);
            else expand(card);
        });
        card.querySelector('[data-action="close"]').addEventListener('click', () => {
            const wasExpanded = card.classList.contains('expanded');
            close(card);
            if (wasExpanded) collapseCard(card);
            else refitCards();
        });
        master.addEventListener('change', () => master.checked && setMaster(card));
        follower.addEventListener('change', () => {
            localStorage.setItem(`phone-sync-target:${device.serial}`, follower.checked ? '1' : '0');
        });
        resume.addEventListener('click', () => activate(card, false, true));
        fileInput.addEventListener('change', () => {
            if (fileInput.files?.length) void uploadFiles(card, [...fileInput.files]);
            fileInput.value = '';
        });
        for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
            card.addEventListener(type, (event) => handleFileDrag(card, event));
        }
        return card;
    }

    function renderDeviceNav(devices) {
        const nav = document.querySelector('.device-nav');
        nav.replaceChildren(Object.assign(document.createElement('h2'), { textContent: '我的设备' }));
        devices.forEach((device, index) => {
            const row = document.createElement('div');
            row.className = 'device-nav-row';
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.focusDevice = device.serial;
            const dot = document.createElement('i');
            const name = document.createElement('span');
            name.className = 'device-nav-name';
            name.textContent = `${index + 1}\u00a0 ${deviceName(device)}`;
            button.append(dot, name);
            const rental = rentalByDevice.get(device.serial);
            if (rental) {
                const badge = document.createElement('small');
                badge.className = `device-rental${rental.expired || rental.disabled ? ' expired' : ''}`;
                badge.textContent = rentalLabel(rental);
                badge.title = badge.textContent;
                button.appendChild(badge);
            }
            button.addEventListener('click', () => {
                const card = cards.find((item) => item.dataset.device === device.serial);
                if (card) expand(card);
            });
            const note = document.createElement('button');
            note.type = 'button';
            note.className = 'device-note';
            note.title = '设置备注';
            note.innerHTML = svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>');
            note.setAttribute('aria-label', '设置备注');
            note.addEventListener('click', () => {
                const current = localStorage.getItem(`phone-device-note:${device.serial}`) || '';
                const input = document.createElement('input');
                input.className = 'device-note-input';
                input.value = current;
                input.placeholder = '输入备注';
                button.replaceWith(input);
                input.focus();
                input.select();
                let finished = false;
                const finish = (cancel = false) => {
                    if (finished) return;
                    finished = true;
                    if (!cancel) {
                        const trimmed = input.value.trim();
                        if (trimmed) localStorage.setItem(`phone-device-note:${device.serial}`, trimmed);
                        else localStorage.removeItem(`phone-device-note:${device.serial}`);
                        const card = cards.find((item) => item.dataset.device === device.serial);
                        const name = deviceName(device);
                        if (card) {
                            card.dataset.name = name;
                            card.querySelector('header strong').textContent = name;
                        }
                    }
                    renderDeviceNav(devices);
                };
                input.addEventListener('blur', () => finish());
                input.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') finish();
                    if (event.key === 'Escape') finish(true);
                });
            });
            row.append(button, note);
            nav.appendChild(row);
        });
        mobilePicker.replaceChildren(...devices.map((device, index) => {
            const option = document.createElement('option');
            option.value = device.serial;
            option.textContent = `${index + 1}. ${deviceName(device)}`;
            return option;
        }));
        mobilePicker.value = activeSerial;
    }

    async function updateAdminVisibility() {
        try {
            const response = await fetch('/api/auth/me', { cache: 'no-store' });
            const data = await response.json();
            const link = document.querySelector('.admin');
            if (link) link.hidden = data.user?.role !== 'admin';
            const addDevice = document.getElementById('add-device');
            if (addDevice) addDevice.hidden = data.user?.role !== 'admin';
            if (data.user?.role === 'admin') {
                const rentalResponse = await fetch('/api/rentals', { cache: 'no-store' });
                if (rentalResponse.ok) {
                    const result = await rentalResponse.json();
                    const nextSignature = JSON.stringify(result.rentals.map((rental) => [rental.id, rental.label, rental.disabled, rental.expired, rental.expiresAt, rental.devices]));
                    if (nextSignature !== rentalSignature) {
                        rentalSignature = nextSignature;
                        rentalByDevice = new Map(result.rentals.flatMap((rental) => rental.devices.map((serial) => [serial, rental])));
                        applyRentalBadges();
                    }
                }
            }
        } catch { /* authentication gate owns navigation errors */ }
    }

    function handleFileDrag(card, event) {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        card.classList.toggle('file-dragging', event.type === 'dragenter' || event.type === 'dragover');
        if (event.type === 'drop' && event.dataTransfer.files.length) void uploadFiles(card, [...event.dataTransfer.files]);
    }

    function uploadFile(card, file, index, total) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const params = new URLSearchParams({ serial: card.dataset.device, name: file.name });
            xhr.open('POST', `/api/devices/file?${params}`);
            xhr.upload.addEventListener('progress', (event) => {
                const percent = event.lengthComputable ? Math.round(event.loaded * 100 / event.total) : 0;
                setState(card, '', `${index}/${total} ${percent}%`);
            });
            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) resolve();
                else reject(new Error(`HTTP ${xhr.status}`));
            });
            xhr.addEventListener('error', () => reject(new Error('network error')));
            xhr.send(file);
        });
    }

    async function uploadFiles(card, files) {
        const accepted = files.filter((file) => /\.(apk|jpe?g|png|webp|gif|heic|heif)$/i.test(file.name));
        card.classList.remove('file-dragging');
        if (!accepted.length) {
            setState(card, 'error', '仅支持图片/APK');
            return;
        }
        try {
            for (let index = 0; index < accepted.length; index += 1) {
                await uploadFile(card, accepted[index], index + 1, accepted.length);
            }
            setState(card, 'connected', accepted.some((file) => /\.apk$/i.test(file.name)) ? '安装完成' : '已存相册');
        } catch (error) {
            console.error('文件传输失败', error);
            setState(card, 'error', '传输失败');
        }
    }

    let devicesRefreshing = false;
    let devicesRefreshQueued = false;
    async function fetchConnectedDevices() {
        let response = await fetch('/api/devices/connected', { cache: 'no-store' });
        if (response.status !== 403) return response;
        await fetch(`/?refresh-token=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
        response = await fetch('/api/devices/connected', { cache: 'no-store' });
        return response;
    }

    async function refreshDevices() {
        if (devicesRefreshing) {
            devicesRefreshQueued = true;
            return;
        }
        devicesRefreshing = true;
        try {
            const response = await fetchConnectedDevices();
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const devices = await response.json();
            visibleDevices = devices;
            const nextKey = devices.map((device) => device.serial).sort().join('|');
            const currentKey = cards.map((card) => card.dataset.device).sort().join('|');
            if (nextKey === currentKey) return;
            cards.forEach((card) => close(card, false));
            grid.replaceChildren();
            cards = devices.map(createCard);
            applyHearPreference();
            ensureSyncSelection();
            ensureActiveSelection();
            renderDeviceNav(devices);
            applyRentalBadges();
            document.getElementById('device-count').textContent = `${devices.length} 台设备 · 版本 ${UI_VERSION}`;
            if (autoArrange || needsInitialLayout) scheduleTile();
        } catch (error) {
            console.error('刷新设备失败', error);
        } finally {
            devicesRefreshing = false;
            if (devicesRefreshQueued) {
                devicesRefreshQueued = false;
                void refreshDevices();
            }
        }
    }

    const AUTO_SIZE_STEPS = [1080, 1600, 2400];

    // 「自动」画质：按画面在屏幕上实际占的物理像素（CSS 尺寸 × devicePixelRatio）
    // 选最小够用的档位。只依赖滑块、视口、展开状态和上次的画面比例，重连时
    // 卡片尺寸被临时清空也不会算出不同结果，避免反复重连。
    function autoMaxSize(card) {
        const dpr = window.devicePixelRatio || 1;
        const aspect = card._lastAspect || 9 / 20;
        const frame = card.querySelector('iframe');
        let boxWidth;
        let boxHeight;
        if (card.classList.contains('expanded')) {
            boxWidth = frame?.clientWidth || 0;
            boxHeight = frame?.clientHeight || 0;
        }
        if (!boxWidth || !boxHeight) {
            boxWidth = Number(tileSize.value) - 2;
            boxHeight = innerHeight - 60 - 96;
        }
        const videoWidth = Math.min(boxWidth, boxHeight * aspect);
        const longSide = Math.max(videoWidth, videoWidth / aspect) * dpr;
        const size = AUTO_SIZE_STEPS.find((step) => step >= longSide) || AUTO_SIZE_STEPS[AUTO_SIZE_STEPS.length - 1];
        return Math.min(size, autoLimit(card.dataset.device));
    }

    // 「自动」先用最低档出画面，确认这台手机在某档能正常出画后才允许再升一档；
    // 升上去黑屏就退回并封顶。这样新手机/新电脑第一次打开也不会黑。
    function autoVerified(serial) {
        try { return Number(localStorage.getItem(`phone-auto-ok:${serial}`)) || 0; } catch { return 0; }
    }

    function autoLimit(serial) {
        const verified = autoVerified(serial);
        const next = AUTO_SIZE_STEPS.find((step) => step > verified) || AUTO_SIZE_STEPS[AUTO_SIZE_STEPS.length - 1];
        return Math.min(autoCap(serial), next);
    }

    // 有的手机（一加/ColorOS 等）在较大分辨率下编码出全黑画面。播放器发现黑屏或
    // 没画面时，「自动」降一档并按设备记住，下次直接用能出画面的档位。
    function autoCap(serial) {
        try {
            const value = Number(localStorage.getItem(`phone-auto-cap:${serial}`));
            return value > 0 ? value : Infinity;
        } catch { return Infinity; }
    }

    function onVideoHealth(card, state) {
        card._videoBlack = state === 'black' || state === 'none';
        paintStreamHint(card);
        const have = card._connectedProfile;
        if (!have || card.dataset.streaming !== '1') return;
        if (state === 'ok') {
            // 服务器把这台手机锁在更小的尺寸（如一加 1080）：实际画面比要的小，就别再往上升档重连了。
            try {
                const canvas = card.querySelector('iframe').contentDocument?.querySelector('.touch-layer');
                const actual = Math.max(canvas?.width || 0, canvas?.height || 0);
                if (actual > 0 && actual < have.maxSize * 0.95 && autoCap(card.dataset.device) > have.maxSize) {
                    localStorage.setItem(`phone-auto-cap:${card.dataset.device}`, String(have.maxSize));
                }
            } catch { /* per-session only */ }
            card._goodProfile = { ...have };
            if (have.maxSize > autoVerified(card.dataset.device)) {
                try { localStorage.setItem(`phone-auto-ok:${card.dataset.device}`, String(have.maxSize)); } catch { /* per-session only */ }
                if (quality.value === 'auto') applyStreamProfile(card);
            }
            return;
        }
        const lower = [...AUTO_SIZE_STEPS].reverse().find((step) => step < have.maxSize);
        if (!lower) {
            // 已是最小尺寸还没画面：多半是刚才为放大/升码率重连后出不来（如安卓 9 的旧手机）。
            // 退回上次出过画面的设置并在本次打开期间固定，不再黑屏。
            const good = card._goodProfile;
            if (good && !card._pinProfile && (good.bitrate !== have.bitrate || good.maxFps !== have.maxFps)) {
                card._pinProfile = good;
                logOperation(card, '提高画质后没出画面，已退回原来的画质');
                connect(card, true);
            }
            return;
        }
        card._healthRetries = (card._healthRetries || 0) + 1;
        if (card._healthRetries > 2) return; // still black at the lowest size: stop reconnecting
        try { localStorage.setItem(`phone-auto-cap:${card.dataset.device}`, String(lower)); } catch { /* per-session only */ }
        // 同时告诉服务器：以后任何浏览器、任何画质档看这台手机都不超过这个尺寸。
        fetch('/api/settings/video-cap', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ udid: card.dataset.device, maxSize: lower }),
        }).catch(() => { /* best effort */ }).finally(() => connect(card, true));
        logOperation(card, `画面${state === 'black' ? '全黑' : '没出来'}，画质降到 ${lower}`);
    }

    // 服务器每秒报一次网络情况（经视频队列测的往返延迟、实际送达码率、丢帧）。
    // 显示在手机下方；短时间内两次跟不上就按实测带宽降码率重连，保证跟手。
    const NET_MIN_BITRATE = 500000;
    // 连续 3 秒收不到画面，或播放器报黑屏：问一下手机屏幕亮没亮，在画面中间给出明确状态。
    function updateStreamHint(card, s) {
        card._zeroFps = s && s.fps > 0 ? 0 : (card._zeroFps || 0) + 1;
        const noPicture = card._zeroFps >= 3 || card._videoBlack;
        const now = Date.now();
        if (noPicture && now - (card._awakeAt || 0) > 5000) {
            card._awakeAt = now;
            fetch(`/api/devices/screen-state?udid=${encodeURIComponent(card.dataset.device)}`, { cache: 'no-store' })
                .then((response) => (response.ok ? response.json() : null))
                .then((state) => {
                    if (state && typeof state.awake === 'boolean') card._awake = state.awake;
                    paintStreamHint(card);
                })
                .catch(() => { /* keep the generic hint */ });
        }
        if (!noPicture) card._awake = undefined;
        paintStreamHint(card);
    }

    function paintStreamHint(card) {
        const hint = card.querySelector('.stream-hint');
        if (!hint) return;
        const noPicture = card.dataset.streaming === '1' && ((card._zeroFps || 0) >= 3 || card._videoBlack);
        hint.hidden = !noPicture;
        if (!noPicture) return;
        const asleep = card._awake === false;
        hint.querySelector('p').textContent = asleep
            ? '手机已息屏，点亮后才有画面'
            : '暂时没有画面：手机可能锁屏/息屏，或网络没把画面送过来';
        hint.querySelector('[data-hint="wake"]').classList.toggle('primary', asleep);
        hint.querySelector('[data-hint="reconnect"]').classList.toggle('primary', !asleep);
    }

    function onNetStats(card, s) {
        if (!s || card.dataset.streaming !== '1' || !card._connectedProfile) return;
        const now = Date.now();
        const have = card._connectedProfile;
        if (typeof s.episodes === 'number') {
            if (card._lastEpisodes === undefined || s.episodes < card._lastEpisodes) card._lastEpisodes = 0;
            if (s.episodes > card._lastEpisodes) {
                card._episodeTimes = [...(card._episodeTimes || []).filter((t) => now - t < 20000), now];
                card._lastEpisodes = s.episodes;
            }
        }
        updateStreamHint(card, s);
        const rtt = s.rttMs >= 0 ? s.rttMs : -1;
        const recent = (card._episodeTimes || []).filter((t) => now - t < 10000).length;
        const level = recent || rtt > 600 ? 'bad' : rtt > 250 || s.decodeQueue > 3 ? 'warn' : 'good';
        const row = card.querySelector('.card-operation-log');
        if (row) {
            const mbps = (v) => (v / 1000000).toFixed(v % 1000000 ? 1 : 0);
            const info = `延迟${rtt >= 0 ? `${rtt}ms` : '…'} · ${s.fps || 0}帧 · ${(s.goodputKbps / 1000).toFixed(1)}/${mbps(have.bitrate)}M`
                + (s.dropped ? ` · 丢${s.dropped}` : '');
            row.dataset.stream = info;
            row.dataset.net = level;
            row.title = `往返延迟（含排队）${rtt >= 0 ? `${rtt} ms` : '测量中'}；收到 ${s.fps || 0} 帧/秒；实际送达 ${(s.goodputKbps / 1000).toFixed(2)} Mbps，设定 ${mbps(have.bitrate)} Mbps；`
                + `网络跟不上 ${s.episodes || 0} 次，跳过 ${s.dropped || 0} 帧；在途 ${Math.round((s.inflight || 0) / 1024)} KB；解码排队 ${s.decodeQueue || 0}；画面 ${card._streamInfo || ''}`;
        }
        // 降码率：20 秒内跟不上 2 次，且距上次调整超过 20 秒。
        if ((card._episodeTimes || []).length >= 2 && now - (card._netAdjustedAt || 0) > 20000 && have.bitrate > NET_MIN_BITRATE) {
            const capacity = s.capacityKbps > 0 ? s.capacityKbps * 1000 * 0.7 : Infinity;
            const target = Math.max(NET_MIN_BITRATE, Math.round(Math.min(have.bitrate * 0.6, capacity) / 100000) * 100000);
            if (target < have.bitrate) {
                card._netBitrate = target;
                card._netAdjustedAt = now;
                card._episodeTimes = [];
                logOperation(card, `网络跟不上${s.capacityKbps ? `（实测约 ${(s.capacityKbps / 1000).toFixed(1)}M）` : ''}，码率降到 ${(target / 1000000).toFixed(1)}M 保证跟手`);
                connect(card, true);
            }
        }
    }

    const PREVIEW_BITRATE = 800000;
    // 用户刚操作过（3 秒内）就不为「升画质」重连，等停手再升，免得点到一半画面闪断。
    const INPUT_IDLE_MS = 3000;
    function userBusy(card) {
        return Date.now() - (card._lastInputAt || 0) < INPUT_IDLE_MS;
    }

    function openCount() {
        return cards.filter((item) => !item.classList.contains('closed')).length;
    }

    function videoProfile(card) {
        if (card._pinProfile) return { ...card._pinProfile };
        // scrcpy maxSize limits the LONGEST side. Option values are long-side
        // pixels (1080/1600/2400 ≈ 480p/720p/1080p on a 20:9 phone).
        const netBitrate = card._netBitrate || Infinity;
        // 网络慢、码率被降到 1.5M 以下时，「自动」不再用大分辨率（低码率大画面又糊又费解码）。
        const requestedSize = quality.value === 'auto'
            ? (netBitrate < 1500000 ? Math.min(1080, autoMaxSize(card)) : autoMaxSize(card))
            : Number(quality.value);
        const requestedFps = Number(fps.value);
        const activeBitrate = Math.min(netBitrate, requestedSize > 1600 ? 8000000 : requestedSize > 1080 ? 4000000 : 2000000);
        // 九宫格小窗只用来看：低码率、15 帧、最多 1080，省流量；点开全屏才用正常画质。
        // 只有 4 台以上才压低小窗画质；台数少时小窗和放大用同一路流，点开不用重连、不会黑一下。
        if (!card.classList.contains('expanded') && openCount() > 3) {
            return {
                bitrate: Math.min(PREVIEW_BITRATE, activeBitrate),
                maxFps: Math.min(15, requestedFps),
                maxSize: Math.min(1080, requestedSize),
            };
        }
        return { bitrate: activeBitrate, maxFps: requestedFps, maxSize: requestedSize };
    }

    function streamUrl(card) {
        if (streamMode === 'snapshot') {
            const params = new URLSearchParams({
                device: card.dataset.device,
                interval: '0',
                ui: '20261113z6',
            });
            return `snapshot.html?${params}`;
        }
        const profile = videoProfile(card);
        card._connectedProfile = profile;
        const params = new URLSearchParams({
            device: card.dataset.device,
            deviceKind: card.dataset.deviceKind || 'phone',
            codec: 'h264',
            bitrate: String(profile.bitrate),
            maxFps: String(profile.maxFps),
            maxSize: String(profile.maxSize),
            secure: location.protocol === 'https:' ? 'true' : 'false',
            ui: '20261113z6',
        });
        params.set('audio', card.dataset.hear === '1' ? 'true' : 'false');
        if (card.dataset.hear === '1' && denoiseFor(card.dataset.device) !== 'normal') void sendDenoise(card, denoiseFor(card.dataset.device));
        if (card.dataset.hear === '1' && audioSourceFor(card.dataset.device) === 'playback') {
            params.set('audioSource', 'playback');
            params.set('audioDup', 'false');
        }
        // http:// public addresses have no WebCodecs audio decoder; ask the
        // phone for plain PCM, which the page can play without decoding.
        if (card.dataset.hear === '1' && (!window.isSecureContext || typeof window.AudioDecoder === 'undefined')) {
            params.set('audioCodec', 'raw');
        }
        return `embed.html?${params}`;
    }

    // 「整机输出」(REMOTE_SUBMIX) 在部分机型（实测一加 ColorOS 14）只采到静音；
    // 「应用播放」(Android 13+ playback capture) 能采到。采到静音就自动换一次并按设备记住。
    function audioSourceFor(serial) {
        try { return localStorage.getItem(`phone-audio-source:${serial}`) || ''; } catch { return ''; }
    }
    function switchToPlaybackOnSilence(card, problem) {
        const serial = card.dataset.device;
        if (!problem.startsWith('收到的全是静音') || audioSourceFor(serial) === 'playback') return false;
        try { localStorage.setItem(`phone-audio-source:${serial}`, 'playback'); } catch { return false; }
        logOperation(card, '整机输出采到的是静音，已自动改用「应用播放」采集并重连声音');
        connect(card, true);
        return true;
    }

    function paintAudioNote(card, note) {
        const button = card.querySelector('[data-action="hear"]');
        if (!button) return;
        const problem = card.dataset.hear === '1' && note && !note.hidden ? note.textContent.trim() : '';
        if (problem && switchToPlaybackOnSilence(card, problem)) return;
        button.classList.toggle('warn', Boolean(problem));
        button.title = problem || '听这部手机正在播放的声音。不需要 root，也不是麦克风注入。再点一次停止。';
        if (problem && problem !== card._audioProblem) logOperation(card, `没有声音：${problem.replace(/^没有声音：/, '')}`);
        card._audioProblem = problem;
    }

    // A click anywhere on the console is a user gesture: let the listening
    // stream retry its AudioContext (browsers start it muted otherwise).
    document.addEventListener('pointerdown', () => {
        snapshotAudio?.handle.resume?.();
        for (const card of cards) {
            if (card.dataset.hear !== '1') continue;
            card.querySelector('iframe')?.contentWindow?.postMessage({ type: 'phone-audio-resume' }, location.origin);
        }
    }, true);

    // 听声音 used to start off on every page load, so people simply never
    // heard anything. Remember the choice; with a single phone and no saved
    // choice, listen by default.
    function applyHearPreference() {
        let pref = null;
        try { pref = localStorage.getItem('phone-hear'); } catch { /* storage blocked */ }
        const target = pref && pref !== 'off'
            ? cards.find((card) => card.dataset.device === pref)
            : pref === null && cards.length === 1 ? cards[0] : null;
        if (!target || streamMode === 'snapshot') return;
        target.dataset.hear = '1';
        paintHear(target);
    }

    function saveHearPreference(serial) {
        try { localStorage.setItem('phone-hear', serial || 'off'); } catch { /* storage blocked */ }
    }

    function paintHear(card) {
        const button = card.querySelector('[data-action="hear"]');
        if (!button) return;
        const on = card.dataset.hear === '1';
        button.textContent = on ? '停止' : '听声音';
        button.classList.toggle('active', on);
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        paintDenoise(card);
    }

    // 降噪（只对没 ROOT 的安卓 8-10 录外放有效）：标准 / 强 / 关，按手机记住，改了立即生效不用重连。
    const DENOISE_LEVELS = ['normal', 'strong', 'off'];
    const DENOISE_LABELS = { normal: '降噪', strong: '强降噪', off: '降噪关' };
    function denoiseFor(serial) {
        try { return DENOISE_LEVELS.includes(localStorage.getItem(`phone-denoise:${serial}`)) ? localStorage.getItem(`phone-denoise:${serial}`) : 'normal'; } catch { return 'normal'; }
    }
    function paintDenoise(card) {
        const button = card.querySelector('[data-action="denoise"]');
        if (!button) return;
        const level = denoiseFor(card.dataset.device);
        button.hidden = card.dataset.hear !== '1';
        button.textContent = DENOISE_LABELS[level];
        button.classList.toggle('active', level !== 'off');
    }
    async function sendDenoise(card, level) {
        try {
            await fetch('/api/devices/audio-denoise', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ device: card.dataset.device, level }),
            });
        } catch { /* best effort: applies on the next connect */ }
    }
    function cycleDenoise(card) {
        const level = DENOISE_LEVELS[(DENOISE_LEVELS.indexOf(denoiseFor(card.dataset.device)) + 1) % DENOISE_LEVELS.length];
        try { localStorage.setItem(`phone-denoise:${card.dataset.device}`, level); } catch { /* storage blocked */ }
        paintDenoise(card);
        logOperation(card, level === 'off' ? '已关闭降噪' : level === 'strong' ? '已开强降噪（小声也会被压掉）' : '已开降噪');
        void sendDenoise(card, level);
    }

    let browserMic = PhoneBrowserMic.initialBrowserMic();
    try {
        const saved = JSON.parse(localStorage.getItem('phone-browser-mic-off') || '[]');
        if (Array.isArray(saved)) browserMic.paused = saved.filter((item) => typeof item === 'string');
    } catch { /* ignore a broken preference */ }

    function saveBrowserMic() {
        localStorage.setItem('phone-browser-mic-off', JSON.stringify(browserMic.paused));
    }

    function paintBrowserMic(card) {
        const button = card.querySelector('[data-action="browser-mic"]');
        if (!button) return;
        const serial = card.dataset.device;
        const paused = browserMic.paused.includes(serial);
        const mine = browserMic.active === serial || browserMic.owner === serial;
        let label = '开麦克风';
        if (paused || (mine && browserMic.phase === 'closed-by-user')) label = '麦克风关';
        else if (mine && browserMic.phase === 'requesting') label = '正在请求';
        else if (mine && browserMic.phase === 'capturing') {
            const phone = card._micPhone;
            label = phone && phone.ready ? '送往手机' : phone ? '麦克风未通' : '采集中';
        }
        else if (mine && browserMic.phase === 'denied') label = '允许麦克风';
        button.textContent = label;
        button.classList.toggle('active', label === '采集中' || label === '送往手机' || label === '麦克风未通');
        button.classList.toggle('warn', label === '麦克风未通');
        button.title = label === '麦克风未通'
            ? `只影响麦克风，不影响画面和操作：电脑麦克风在采集，但手机还收不到：${card._micPhone?.reason || '手机端麦克风注入未就绪'}。点此关闭。`
            : label === '送往手机'
            ? '电脑麦克风的声音正在送进这部手机。微信等 App 是否有声取决于它们是否在用麦克风。点此关闭，关闭后不会自动再开。'
            : label === '采集中'
            ? '浏览器正在采集麦克风。手机能否注入看功能菜单里的状态，不代表微信有声。点此关闭，关闭后不会自动再开。'
            : label === '允许麦克风'
                ? '浏览器还没有允许麦克风。点此再请求一次。这不是手机未就绪。'
                : label === '麦克风关'
                    ? '浏览器麦克风已关闭，不会自动重新打开。'
                    : '点此为当前手机打开浏览器麦克风。需要浏览器自己的许可。';
    }

    function postBrowserMic(serial, action, persist) {
        const card = cards.find((item) => item.dataset.device === serial);
        card?.querySelector('iframe')?.contentWindow?.postMessage(
            { type: 'phone-browser-mic', action, persist: persist === true },
            location.origin,
        );
    }

    function applyBrowserMic(event) {
        const previousOwner = browserMic.owner;
        const effect = PhoneBrowserMic.reduceBrowserMic(browserMic, event);
        browserMic = effect.state;
        saveBrowserMic();
        if (effect.stop && previousOwner) postBrowserMic(previousOwner, 'stop', event.type === 'user-off');
        cards.forEach(paintBrowserMic);
        if (effect.start) void primeBrowserMic(effect.start);
    }

    function primeBrowserMic(serial) {
        const card = cards.find((item) => item.dataset.device === serial);
        const media = navigator.mediaDevices;
        if (!media?.getUserMedia) {
            applyBrowserMic({ type: 'denied' });
            if (card) logOperation(card, '这个浏览器不能采集麦克风');
            return;
        }
        media.getUserMedia({ audio: { channelCount: 1 }, video: false }).then((stream) => {
            stream.getTracks().forEach((track) => track.stop());
            if (browserMic.owner !== serial || browserMic.phase !== 'requesting') return;
            applyBrowserMic({ type: 'granted' });
            postBrowserMic(serial, 'start', false);
            if (card) logOperation(card, '浏览器麦克风已允许。手机注入是否就绪另行显示，不代表微信有声。');
        }).catch((err) => {
            if (browserMic.owner !== serial || browserMic.phase !== 'requesting') return;
            applyBrowserMic({ type: 'denied' });
            if (!card) return;
            const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
            logOperation(card, denied
                ? '浏览器没有允许麦克风。点允许麦克风再试。这不是手机未就绪。'
                : '浏览器麦克风没有打开。');
        });
    }

    function toggleBrowserMic(card) {
        const serial = card.dataset.device;
        const capturing = browserMic.owner === serial && browserMic.phase === 'capturing';
        applyBrowserMic(capturing ? { type: 'user-off', serial } : { type: 'user-on', serial });
    }

    // 抽帧远控没有视频流：声音单独走一条只要声音的会话，在这次点击里开 AudioContext。
    let snapshotAudio = null;
    function stopSnapshotAudio() {
        if (!snapshotAudio) return;
        snapshotAudio.handle.stop();
        snapshotAudio = null;
    }
    function startSnapshotAudio(card) {
        stopSnapshotAudio();
        if (!window.PhoneAudio) {
            logOperation(card, '声音组件没加载，刷新页面再试');
            return;
        }
        const serial = card.dataset.device;
        const handle = window.PhoneAudio.start(serial, (text, problem) => {
            if (!snapshotAudio || snapshotAudio.serial !== serial) return;
            const button = card.querySelector('[data-action="hear"]');
            button?.classList.toggle('warn', Boolean(problem));
            if (button) button.title = text || '正在播放手机声音，再点一次停止';
            if (text && text !== card._audioProblem) logOperation(card, text);
            card._audioProblem = text;
        });
        snapshotAudio = { serial, handle };
    }

    function toggleHear(card) {
        const enable = card.dataset.hear !== '1';
        if (streamMode === 'snapshot') {
            for (const other of cards) {
                if (other === card || other.dataset.hear !== '1') continue;
                delete other.dataset.hear;
                paintHear(other);
            }
            if (enable) card.dataset.hear = '1';
            else delete card.dataset.hear;
            paintHear(card);
            saveHearPreference(enable ? card.dataset.device : '');
            if (enable) startSnapshotAudio(card);
            else {
                stopSnapshotAudio();
                logOperation(card, '已停止听音');
            }
            return;
        }
        if (enable) {
            for (const other of cards) {
                if (other === card || other.dataset.hear !== '1') continue;
                delete other.dataset.hear;
                paintHear(other);
                if (other.dataset.streaming === '1') connect(other, true);
            }
            card.dataset.hear = '1';
        } else {
            delete card.dataset.hear;
        }
        paintHear(card);
        saveHearPreference(enable ? card.dataset.device : '');
        logOperation(card, enable ? '正在打开这部手机的播放声音' : '已停止听音');
        if (card.dataset.streaming === '1') connect(card, true);
        else activate(card);
    }

    function applyStreamProfile(card) {
        if (card.dataset.streaming !== '1') return;
        const frame = card.querySelector('iframe');
        try {
            const status = frame.contentDocument?.getElementById('status');
            if (!status || (!status.classList.contains('hidden') && !/^connected|^已连接/i.test(status.textContent))) return;
        } catch { return; }
        if (streamMode !== 'snapshot') {
            // scrcpy 4.1 drops live video-setting changes (control type 101),
            // so a card that connected as a throttled background stream keeps
            // 1 Mbps/15 fps forever. Reconnect once when it needs more.
            const want = videoProfile(card);
            const have = card._connectedProfile;
            if (!have) return;
            // 刚点开全屏：等布局定下来（expand 里 420ms 后再算一次），只重连一次。
            if (card.classList.contains('expanded') && Date.now() - (card._expandAt || 0) < 400) return;
            if (want.bitrate > have.bitrate || want.maxFps > have.maxFps || (quality.value !== 'auto' && want.maxSize > have.maxSize)) {
                connect(card, true);
                return;
            }
            if (quality.value === 'auto' && want.maxSize > have.maxSize) {
                // Only step up automatically (a bigger window needs more pixels);
                // stepping down is not worth a reconnect. Debounce until the
                // resize/expand has settled.
                clearTimeout(card._autoTimer);
                const tryStepUp = () => {
                    card._autoTimer = 0;
                    if (card.dataset.streaming !== '1' || !card._connectedProfile
                        || videoProfile(card).maxSize <= card._connectedProfile.maxSize) return;
                    if (userBusy(card)) {
                        card._autoTimer = setTimeout(tryStepUp, INPUT_IDLE_MS);
                        return;
                    }
                    connect(card, true);
                };
                card._autoTimer = setTimeout(tryStepUp, 1500);
            }
            return;
        }
        const message = { type: 'phone-frame-profile', intervalMs: 0 };
        const signature = JSON.stringify(message);
        if (card.dataset.streamProfile === signature) return;
        frame.contentWindow?.postMessage(message, location.origin);
        card.dataset.streamProfile = signature;
    }

    function setState(card, state, label) {
        if (state === 'connected') {
            clearTimeout(card._watchdog);
            card._watchdog = 0;
            card._retries = 0;
        }
        const el = card.querySelector('.connection-state');
        el.className = `connection-state ${state}`;
        el.textContent = label;
        if (state === 'connected' || state === 'error') card.classList.remove('reconnecting');
    }

    /** 按打开的手机数（最多 9）算出一屏放得下的小窗尺寸：试每种列数，取画面最大的。 */
    function gridFit(chrome, aspect) {
        // 不管现在几台，小窗都按「一屏放 9 台」的一格大小，1~2 台时也不会撑满。
        const n = 9;
        const gap = 12;
        const W = Math.max(200, grid.clientWidth);
        const H = Math.max(200, grid.clientHeight);
        let best = { width: Infinity, videoHeight: Infinity, score: 0 };
        for (let cols = 1; cols <= n; cols++) {
            const rows = Math.ceil(n / cols);
            const cellW = (W - gap * (cols + 1)) / cols;
            const cellH = (H - gap * (rows + 1)) / rows;
            let videoH = cellH - chrome;
            let videoW = videoH * aspect;
            if (videoW > cellW - 2) { videoW = cellW - 2; videoH = videoW / aspect; }
            if (videoW > best.score) best = { width: Math.floor(videoW + 2), videoHeight: Math.floor(videoH), score: videoW };
        }
        // 太小就不再缩（下面翻页滚动看）。
        if (best.width < 150) return { width: 150, videoHeight: Math.floor(148 / aspect) };
        return best;
    }

    function refitCards() {
        cards.forEach((card) => {
            if (card.classList.contains('closed')) return;
            card._videoAspect = 0;
            applyFrameState(card);
        });
        scheduleTile();
    }

    function fitCardToPhone(card, canvas, toolbar) {
        if (card.classList.contains('expanded') || card.classList.contains('closed') || !canvas.width || !canvas.height) return;
        const border = 2;
        const headerHeight = card.querySelector(':scope > header').offsetHeight;
        const footerHeight = card.querySelector('.phone-nav').offsetHeight + card.querySelector('.card-operation-log').offsetHeight;
        const toolbarWidth = toolbar?.ownerDocument?.body?.hasAttribute('data-embed-entry')
            ? 0
            : Math.ceil(toolbar?.getBoundingClientRect().width || 60);
        // 九宫格：一屏尽量放下（最多 9 台），窗口大小档位是上限。
        const fit = gridFit(headerHeight + footerHeight + border, canvas.width / canvas.height);
        const maxWidth = Math.min(Number(tileSize.value), fit.width);
        const maxVideoWidth = Math.max(1, maxWidth - toolbarWidth - border);
        const maxVideoHeight = Math.max(1, Math.min(innerHeight - 60 - headerHeight - footerHeight - border, fit.videoHeight));
        const ratio = canvas.width / canvas.height;
        // The card cannot be narrower than its CSS min-width (header buttons).
        // When the height cap would make the video narrower than that, grow
        // the height instead of leaving bars beside the picture.
        const minVideoWidth = Math.max(1, (parseFloat(getComputedStyle(card).minWidth) || 0) - toolbarWidth - border);
        const viewportVideoHeight = Math.max(1, innerHeight - 60 - headerHeight - footerHeight - border);
        let videoWidth = Math.min(maxVideoWidth, maxVideoHeight * ratio);
        if (videoWidth < minVideoWidth) videoWidth = Math.min(minVideoWidth, viewportVideoHeight * ratio);
        const videoHeight = videoWidth / ratio;
        card.style.width = `${Math.ceil(videoWidth + toolbarWidth + border)}px`;
        card.style.height = `${Math.ceil(videoHeight + headerHeight + footerHeight + border)}px`;
    }

    function logStreamInfo(card, canvas) {
        if (streamMode === 'snapshot' || !canvas?.width || !card._connectedProfile) return;
        const { bitrate, maxFps } = card._connectedProfile;
        // Shown permanently at the right of the log row so operations don't hide it.
        const info = `${canvas.width}×${canvas.height} · ${(bitrate / 1000000).toFixed(bitrate % 1000000 ? 1 : 0)}M · ${maxFps}fps`;
        if (card._streamInfo === info) return;
        card._streamInfo = info;
        const row = card.querySelector('.card-operation-log');
        if (row) row.dataset.stream = info;
    }

    function fitStreamToFrame(card, doc, canvas) {
        if (!canvas?.width || !canvas.height) return;
        const frame = card.querySelector('iframe');
        const ratio = canvas.width / canvas.height;
        const width = Math.min(frame.clientWidth, frame.clientHeight * ratio);
        const height = width / ratio;
        for (const layer of doc.querySelectorAll('.video-layer, .touch-layer')) {
            layer.style.width = `${Math.round(width)}px`;
            layer.style.height = `${Math.round(height)}px`;
            layer.style.transform = '';
        }
    }

    function alignNativeInputLayer(card, canvas) {
        if (!nativeMacShell || !canvas) return;
        const layer = card.querySelector('.native-input-layer');
        const frame = card.querySelector('iframe');
        const cardRect = card.getBoundingClientRect();
        const frameRect = frame.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        if (!canvasRect.width || !canvasRect.height) return;
        const toolsWidth = card.classList.contains('tools-open') ? Math.min(140, canvasRect.width) : 0;
        layer.style.left = `${frameRect.left - cardRect.left + canvasRect.left}px`;
        layer.style.top = `${frameRect.top - cardRect.top + canvasRect.top}px`;
        layer.style.width = `${Math.max(0, canvasRect.width - toolsWidth)}px`;
        layer.style.height = `${canvasRect.height}px`;
    }

    function installNativeInputBridge(card, canvas) {
        if (!nativeMacShell || !canvas) return;
        const layer = card.querySelector('.native-input-layer');
        card._nativeCanvas = canvas;
        alignNativeInputLayer(card, canvas);
        if (layer._bridgeInstalled) return;
        layer._bridgeInstalled = true;

        const forward = (event) => {
            const target = card._nativeCanvas;
            if (!target) return;
            const view = target.ownerDocument.defaultView;
            const layerRect = layer.getBoundingClientRect();
            const canvasRect = target.getBoundingClientRect();
            const options = {
                bubbles: true,
                cancelable: true,
                view,
                clientX: canvasRect.left + event.clientX - layerRect.left,
                clientY: canvasRect.top + event.clientY - layerRect.top,
                button: event.button,
                buttons: event.buttons,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
            };
            if (event.type === 'wheel') {
                target.dispatchEvent(new view.WheelEvent('wheel', {
                    ...options,
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                    deltaMode: event.deltaMode,
                }));
            } else {
                const PointerEventClass = view.PointerEvent;
                if (PointerEventClass) {
                    target.dispatchEvent(new PointerEventClass(event.type, {
                        ...options,
                        pointerId: event.pointerId,
                        pointerType: event.pointerType || 'mouse',
                        isPrimary: event.isPrimary,
                        pressure: event.pressure,
                    }));
                } else {
                    const mouseType = { pointerdown: 'mousedown', pointermove: 'mousemove', pointerup: 'mouseup', pointercancel: 'mouseup' }[event.type];
                    target.dispatchEvent(new view.MouseEvent(mouseType, options));
                }
            }
            event.preventDefault();
            event.stopPropagation();
        };

        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
            layer.addEventListener(type, (event) => {
                if (type === 'pointerdown') layer.setPointerCapture?.(event.pointerId);
                forward(event);
                if ((type === 'pointerup' || type === 'pointercancel') && layer.hasPointerCapture?.(event.pointerId)) {
                    layer.releasePointerCapture(event.pointerId);
                }
            }, { passive: false });
        }
        layer.addEventListener('wheel', forward, { passive: false });
    }

    function pressPhoneButton(card, title) {
        const button = [...(card.querySelector('iframe').contentDocument?.querySelectorAll('.control-buttons-list button') || [])]
            .find((item) => item.title === title);
        if (!button) return;
        if (title === '截图') {
            button.click();
            logOperation(card, '已截图');
            return;
        }
        if (streamMode === 'snapshot') {
            button.click();
            return;
        }
        for (const type of ['mousedown', 'mouseup']) {
            button.dispatchEvent(new button.ownerDocument.defaultView.MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                button: 0,
                buttons: type === 'mousedown' ? 1 : 0,
            }));
        }
        if (streamMode === 'video') logOperation(card, { 返回: '已返回', 主页: '已回到主页', 多任务: '已打开多任务' }[title] || `已执行${title}`);
    }

    function applyFrameState(card) {
        try {
            const frame = card.querySelector('iframe');
            const doc = frame.contentDocument;
            // While the iframe navigates to a new stream, observers can still
            // fire for the old document; don't report its state as current.
            if (doc && frame.src && doc.URL !== frame.src) return;
            const status = doc?.getElementById('status');
            if (!status) return;
            doc.documentElement.setAttribute('data-theme', 'dark');
            doc.body.classList.toggle('tools-expanded', card.classList.contains('tools-open'));
            installSyncBridge(card, doc);
            const canvas = doc.querySelector('.touch-layer');
            fitStreamToFrame(card, doc, canvas);
            installNativeInputBridge(card, canvas);
            // 画面没出来前 canvas 是默认的 300×150，别拿它当手机比例（会把放大窗口撑成横的）。
            const realCanvas = canvas && !(canvas.width === 300 && canvas.height === 150);
            const aspect = realCanvas ? canvas.width / canvas.height : 0;
            if (aspect && aspect !== card._videoAspect) {
                card._videoAspect = aspect;
                card._lastAspect = aspect;
                sizeExpanded(card);
                fitCardToPhone(card, canvas, doc.querySelector('.control-buttons-list'));
                if (autoArrange || needsInitialLayout) scheduleTile();
            }
            if (card.classList.contains('expanded')) sizeExpanded(card);
            paintAudioNote(card, doc.getElementById('audio-note'));
            if (status.classList.contains('hidden') || /^connected\b/i.test(status.textContent)) {
                setState(card, 'connected', '已连接');
                logStreamInfo(card, canvas);
            }
            else if (/error|disconnected/i.test(status.textContent)) {
                const detail = status.textContent.replace(/\s+/g, ' ').trim().slice(0, 96);
                setState(card, 'error', detail || '连接失败');
            }
            else setState(card, '', '连接中');
            applyStreamProfile(card);
        } catch { /* status is cosmetic; stream control remains available */ }
    }

    function clearFrameObservers(card, removeLoadHandler = true) {
        card._statusObserver?.disconnect();
        card._canvasObserver?.disconnect();
        card._documentObserver?.disconnect();
        card._resizeObserver?.disconnect();
        card._statusObserver = card._canvasObserver = card._documentObserver = card._resizeObserver = null;
        if (removeLoadHandler && card._frameLoadHandler) {
            card.querySelector('iframe').removeEventListener('load', card._frameLoadHandler);
            card._frameLoadHandler = null;
        }
    }

    function watchState(card) {
        clearFrameObservers(card);
        const frame = card.querySelector('iframe');
        const attach = () => {
            clearFrameObservers(card, false);
            try {
                const doc = frame.contentDocument;
                const status = doc?.getElementById('status');
                if (!status) return;
                const canvas = doc.querySelector('.touch-layer');
                applyFrameState(card);
                const MutationObserverClass = doc.defaultView.MutationObserver;
                card._statusObserver = new MutationObserverClass(() => applyFrameState(card));
                if (!doc.defaultView._phoneHealthHooked) {
                    doc.defaultView._phoneHealthHooked = true;
                    doc.defaultView.addEventListener('phone-video-health', (event) => onVideoHealth(card, event.detail?.state));
                    doc.defaultView.addEventListener('phone-net-stats', (event) => onNetStats(card, event.detail));
                }
                card._statusObserver.observe(status, { attributes: true, childList: true, characterData: true, subtree: true });
                card._documentObserver = new MutationObserverClass(() => applyFrameState(card));
                card._documentObserver.observe(doc.body, { childList: true, subtree: true });
                if (canvas) {
                    card._canvasObserver = new MutationObserverClass(() => applyFrameState(card));
                    card._canvasObserver.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
                }
                const ResizeObserverClass = doc.defaultView.ResizeObserver;
                if (ResizeObserverClass) {
                    card._resizeObserver = new ResizeObserverClass(() => applyFrameState(card));
                    card._resizeObserver.observe(frame);
                    if (canvas) card._resizeObserver.observe(canvas);
                }
            } catch { /* iframe may still be navigating */ }
        };
        card._frameLoadHandler = attach;
        frame.addEventListener('load', attach);
        attach();
    }

    function setMaster(card) {
        masterSerial = card.dataset.device;
        localStorage.setItem('phone-sync-master', masterSerial);
        cards.forEach((item) => {
            const isMaster = item === card;
            const master = item.querySelector('.sync-master');
            const follower = item.querySelector('.sync-target');
            master.checked = isMaster;
            follower.disabled = isMaster;
            if (isMaster) follower.checked = false;
        });
    }

    function ensureSyncSelection() {
        let master = cards.find((card) => card.dataset.device === masterSerial) || cards[0];
        if (!master) return;
        setMaster(master);
    }

    function ensureActiveSelection() {
        const active = cards.find((card) => card.dataset.device === activeSerial && !card.classList.contains('closed')) || cards[0];
        if (!active) return;
        activeSerial = active.dataset.device;
        localStorage.setItem('phone-active-device', activeSerial);
        updateStreamingMode();
    }

    function syncTargets(source) {
        return cards.filter((card) =>
            card !== source && !card.classList.contains('closed') && card.querySelector('.sync-target')?.checked
        );
    }

    function replayPointer(source, event, canvas) {
        const sourceRect = canvas.getBoundingClientRect();
        if (!sourceRect.width || !sourceRect.height) return;
        const x = Math.max(0, Math.min(1, (event.clientX - sourceRect.left) / sourceRect.width));
        const y = Math.max(0, Math.min(1, (event.clientY - sourceRect.top) / sourceRect.height));
        syncTargets(source).forEach((card) => {
            const target = card.querySelector('iframe').contentDocument?.querySelector('.touch-layer');
            if (!target) return;
            const rect = target.getBoundingClientRect();
            const options = {
                bubbles: true, cancelable: true, view: target.ownerDocument.defaultView,
                clientX: rect.left + x * rect.width, clientY: rect.top + y * rect.height,
                button: event.button, buttons: event.buttons,
                ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
            };
            const copy = event.type === 'wheel'
                ? new target.ownerDocument.defaultView.WheelEvent(event.type, { ...options, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode })
                : event.type.startsWith('pointer')
                    ? new target.ownerDocument.defaultView.PointerEvent(event.type, {
                        ...options, pointerId: event.pointerId, pointerType: event.pointerType,
                        isPrimary: event.isPrimary, pressure: event.pressure,
                    })
                : new target.ownerDocument.defaultView.MouseEvent(event.type, options);
            target.dispatchEvent(copy);
        });
    }

    function replayToolbar(source, button, eventType = 'click') {
        const identity = button.title || button.getAttribute('aria-label');
        if (!identity) return;
        syncTargets(source).forEach((card) => {
            const buttons = card.querySelector('iframe').contentDocument?.querySelectorAll('.control-buttons-list button') || [];
            const target = [...buttons].find((item) => (item.title || item.getAttribute('aria-label')) === identity);
            if (!target) return;
            if (eventType === 'click') target.click();
            else target.dispatchEvent(new target.ownerDocument.defaultView.MouseEvent(eventType, { bubbles: true, cancelable: true, button: 0, buttons: eventType === 'mousedown' ? 1 : 0 }));
        });
    }

    function replayKey(source, event) {
        syncTargets(source).forEach((card) => {
            const doc = card.querySelector('iframe').contentDocument;
            if (!doc) return;
            const copy = new doc.defaultView.KeyboardEvent(event.type, {
                bubbles: true, cancelable: true, key: event.key, code: event.code,
                repeat: event.repeat, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
                altKey: event.altKey, metaKey: event.metaKey,
            });
            (doc.activeElement || doc.body).dispatchEvent(copy);
        });
    }

    function forwardDesktopKeyboard(event) {
        if (!desktopKeyboard || event.defaultPrevented) return false;
        const source = event.target instanceof Element ? event.target : null;
        if (source?.closest('input, select, textarea, [contenteditable="true"]')) return false;
        if (source?.closest('button, a') && (event.key === 'Enter' || event.key === ' ')) return false;
        // 键盘只发给全屏的那台；九宫格状态下不发，避免误操作。
        const expandedCards = cards.filter((item) => item.classList.contains('expanded') && !item.classList.contains('closed'));
        const card = expandedCards.find((item) => item.dataset.device === activeSerial) || expandedCards[expandedCards.length - 1];
        const doc = card?.querySelector('iframe')?.contentDocument;
        if (!card || !doc?.body) return false;
        const copy = new doc.defaultView.KeyboardEvent(event.type, {
            bubbles: true,
            cancelable: true,
            key: event.key,
            code: event.code,
            location: event.location,
            repeat: event.repeat,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
        });
        (doc.activeElement || doc.body).dispatchEvent(copy);
        if (syncEnabled && card.dataset.device === masterSerial) replayKey(card, event);
        if (copy.defaultPrevented) event.preventDefault();
        return copy.defaultPrevented;
    }

    function installSyncBridge(card, doc) {
        if (doc.__phoneSyncInstalled) return;
        doc.__phoneSyncInstalled = true;
        doc.addEventListener('pointerdown', () => {
            if (card.dataset.device !== activeSerial) activate(card, false, true);
        }, true);
        // 焦点在手机画面里时 Esc 也要能回九宫格（否则会被当成按键发给手机）。
        doc.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !card.classList.contains('expanded')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            collapseExpanded();
        }, true);
        for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) {
            doc.addEventListener(type, (event) => {
                if (type === 'pointermove' && !event.buttons) return;
                card._lastInputAt = Date.now();
            }, { capture: true, passive: true });
        }
        let operationGesture = null;
        let lastTap = null;
        doc.addEventListener('pointerdown', (event) => {
            if (streamMode !== 'video' || !event.target?.closest?.('.touch-layer')) return;
            operationGesture = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() };
        }, true);
        doc.addEventListener('pointerup', (event) => {
            if (streamMode !== 'video' || operationGesture?.id !== event.pointerId) return;
            const gesture = operationGesture;
            operationGesture = null;
            const dx = event.clientX - gesture.x;
            const dy = event.clientY - gesture.y;
            if (Math.hypot(dx, dy) >= 12) {
                logOperation(card, Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? '已切换下一条视频' : '已切换上一条视频') : '已左右滑动');
                return;
            }
            const now = performance.now();
            const liked = lastTap && now - lastTap.at < 420 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 60;
            logOperation(card, liked ? '已点赞' : '已点击屏幕');
            lastTap = liked ? null : { x: event.clientX, y: event.clientY, at: now };
        }, true);
        for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
            doc.addEventListener(type, (event) => handleFileDrag(card, event), true);
        }
        let lastMove = 0;
        for (const type of ['mousedown', 'mouseup', 'mousemove', 'wheel', 'pointerdown', 'pointerup', 'pointermove', 'pointercancel']) {
            doc.addEventListener(type, (event) => {
                if (!syncEnabled || card.dataset.device !== masterSerial || !event.isTrusted) return;
                if (type.startsWith('pointer') && event.pointerType === 'mouse') return;
                const button = event.target?.closest?.('.control-buttons-list button');
                if (button && (type === 'mousedown' || type === 'mouseup')) {
                    queueMicrotask(() => replayToolbar(card, button, type));
                    return;
                }
                const canvas = event.target?.closest?.('.touch-layer');
                if (!canvas) return;
                if ((type === 'mousemove' || type === 'pointermove') && Date.now() - lastMove < 12) return;
                if (type === 'mousemove' || type === 'pointermove') lastMove = Date.now();
                queueMicrotask(() => replayPointer(card, event, canvas));
            }, true);
        }
        doc.addEventListener('click', (event) => {
            if (!syncEnabled || card.dataset.device !== masterSerial || !event.isTrusted) return;
            const button = event.target?.closest?.('.control-buttons-list button');
            if (button) queueMicrotask(() => replayToolbar(card, button));
        }, true);
        for (const type of ['keydown', 'keyup']) {
            doc.addEventListener(type, (event) => {
                if (syncEnabled && card.dataset.device === masterSerial && event.isTrusted) {
                    queueMicrotask(() => replayKey(card, event));
                }
            }, true);
        }
    }

    function updateSyncButton() {
        syncToggle.classList.toggle('active', syncEnabled);
        syncToggle.setAttribute('aria-pressed', syncEnabled ? 'true' : 'false');
        syncToggle.querySelector('b').textContent = syncEnabled ? '同步已开' : '同步关闭';
    }

    async function setDeviceScreenPower(card, on) {
        const frame = card.querySelector('iframe');
        frame.contentWindow?.postMessage({ type: 'phone-display-power', on }, location.origin);
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await fetch('/api/devices/sleep-wake', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ udid: card.dataset.device, action: on ? 'wake' : 'sleep' }),
            });
            if (!response.ok) throw new Error(`设备 ${card.dataset.name} 电源操作失败`);
            const result = await response.json();
            if (Boolean(result.awake) === on) {
                frame.contentWindow?.postMessage({ type: 'phone-display-power', on }, location.origin);
                const button = card.querySelector('[data-action="screen-lock"]');
                if (button) button.textContent = on ? '锁屏' : '解锁';
                logOperation(card, on ? '已解锁/唤醒' : '已锁屏');
                return;
            }
        }
        throw new Error(`设备 ${card.dataset.name} 未响应`);
    }

    async function refreshScreenLockButton(card) {
        const button = card.querySelector('[data-action="screen-lock"]');
        if (!button) return;
        try {
            const response = await fetch(`/api/devices/screen-state?udid=${encodeURIComponent(card.dataset.device)}`);
            if (!response.ok) throw new Error('读取屏幕状态失败');
            const { awake } = await response.json();
            button.textContent = awake ? '锁屏' : '解锁';
        } catch {
            button.textContent = '锁屏/解锁';
        }
    }

    async function toggleDeviceScreenLock(card) {
        const button = card.querySelector('[data-action="screen-lock"]');
        if (!button || button.disabled) return;
        button.disabled = true;
        try {
            const response = await fetch(`/api/devices/screen-state?udid=${encodeURIComponent(card.dataset.device)}`);
            if (!response.ok) throw new Error('读取屏幕状态失败');
            const { awake } = await response.json();
            await setDeviceScreenPower(card, !awake);
        } catch (error) {
            notify(error instanceof Error ? error.message : '锁屏/解锁失败', 'err');
        } finally {
            button.disabled = false;
        }
    }

    async function setAllScreenPower(on) {
        const results = await Promise.allSettled(cards.map((card) => setDeviceScreenPower(card, on)));
        const failed = results.filter((result) => result.status === 'rejected');
        if (failed.length) notify(`${failed.length} 台手机${on ? '唤醒' : '熄屏'}失败，请检查 USB 连接。`, 'err');
    }

    function captureLastFrame(card) {
        try {
            const doc = card.querySelector('iframe').contentDocument;
            const canvas = [...(doc?.querySelectorAll('canvas') || [])].find((item) => !item.classList.contains('touch-layer'));
            if (canvas?.width && canvas?.height) card.querySelector('.last-frame').src = canvas.toDataURL('image/jpeg', 0.72);
        } catch { /* keep the previous frame if this decoder cannot be sampled */ }
    }

    const RECONNECT_GAP_MS = 2500;
    const CONNECT_TIMEOUT_MS = 12000;

    function connect(card, force = false) {
        if (card.dataset.streaming === '1' && !force) return;
        card._zeroFps = 0;
        card._videoBlack = false;
        card._awake = undefined;
        const hint = card.querySelector('.stream-hint');
        if (hint) hint.hidden = true;
        // Back-to-back reconnects start two scrcpy sessions on the phone while
        // the first is still coming up, and the second can hang on
        // "connecting...". Coalesce them into one, a little later.
        const sinceLast = Date.now() - (card._connectAt || 0);
        if (force && card.dataset.streaming === '1' && sinceLast < RECONNECT_GAP_MS) {
            if (!card._deferredConnect) {
                card._deferredConnect = setTimeout(() => {
                    card._deferredConnect = 0;
                    if (card.dataset.streaming === '1') connect(card, true);
                }, RECONNECT_GAP_MS - sinceLast);
            }
            return;
        }
        clearTimeout(card._deferredConnect);
        card._deferredConnect = 0;
        clearTimeout(card._autoTimer);
        card._autoTimer = 0;
        card._connectAt = Date.now();
        clearTimeout(card._watchdog);
        card._watchdog = setTimeout(() => {
            card._watchdog = 0;
            if (card.dataset.streaming !== '1' || card.querySelector('.connection-state').classList.contains('connected')) return;
            card._retries = (card._retries || 0) + 1;
            if (card._retries <= 2) connect(card, true);
            else setState(card, 'error', '连接超时，点刷新按钮重连');
        }, CONNECT_TIMEOUT_MS);
        const wasStreaming = card.dataset.streaming === '1';
        if (card.dataset.streaming === '1' && force) {
            captureLastFrame(card);
            if (card.querySelector('.last-frame').src) card.classList.add('reconnecting');
        }
        card.classList.remove('closed', 'paused');
        card.dataset.streaming = '1';
        delete card.dataset.streamProfile;
        card._videoAspect = 0;
        card._streamInfo = '';
        delete card.querySelector('.card-operation-log')?.dataset.stream;
        delete card.querySelector('.card-operation-log')?.dataset.net;
        // Keep the fitted size while reconnecting so the card doesn't turn into
        // a wide black box; it is refitted once the new stream reports its size.
        if (!card._lastAspect) {
            card.style.width = '';
            card.style.height = '';
        }
        setState(card, '', '连接中');
        const frame = card.querySelector('iframe');
        const url = streamUrl(card);
        clearTimeout(card._srcTimer);
        if (wasStreaming && force) {
            // 先断开旧会话，等服务器把手机上的旧 scrcpy 收掉再连新的；
            // 两个会话叠在一起时部分手机（安卓 9 等）新会话只出黑屏。期间显示最后一帧。
            frame.src = 'about:blank';
            card._srcTimer = setTimeout(() => {
                card._srcTimer = 0;
                if (card.dataset.streaming === '1') frame.src = url;
            }, 800);
        } else {
            frame.src = url;
        }
        watchState(card);
    }

    function close(card, update = true) {
        clearTimeout(card._srcTimer);
        card._srcTimer = 0;
        clearFrameObservers(card);
        card.querySelector('iframe').src = 'about:blank';
        card.dataset.streaming = '0';
        if (snapshotAudio?.serial === card.dataset.device) stopSnapshotAudio();
        delete card.dataset.hear;
        delete card._micPhone;
        paintHear(card);
        applyBrowserMic({ type: 'disconnect', serial: card.dataset.device });
        card.classList.add('closed');
        card.classList.remove('paused');
        setState(card, '', '已关闭');
        if (update && card.dataset.device === activeSerial) {
            const next = cards.find((item) => item !== card && !item.classList.contains('closed'));
            activeSerial = next?.dataset.device || '';
            if (activeSerial) localStorage.setItem('phone-active-device', activeSerial);
            else localStorage.removeItem('phone-active-device');
            updateStreamingMode();
        }
    }

    function updateStreamingMode(force = false) {
        cards.forEach((card) => {
            card.classList.toggle('active-stream', card.dataset.device === activeSerial);
            if (card.classList.contains('closed')) return;
            connect(card, force);
            applyStreamProfile(card);
        });
    }

    function setStreamMode(mode, reconnect = true) {
        const changed = streamMode !== mode;
        streamMode = mode;
        if (changed) {
            stopSnapshotAudio();
            cards.forEach((card) => { delete card.dataset.hear; paintHear(card); });
        }
        videoModeButton.classList.toggle('active', mode === 'video');
        snapshotModeButton.classList.toggle('active', mode === 'snapshot');
        videoModeButton.setAttribute('aria-pressed', mode === 'video' ? 'true' : 'false');
        snapshotModeButton.setAttribute('aria-pressed', mode === 'snapshot' ? 'true' : 'false');
        if (reconnect && changed) updateStreamingMode(true);
    }

    function activate(card, force = false, gesture = false) {
        if (card.classList.contains('closed')) card.classList.remove('closed');
        const previousSerial = activeSerial;
        activeSerial = card.dataset.device;
        localStorage.setItem('phone-active-device', activeSerial);
        mobilePicker.value = activeSerial;
        cards.forEach((item) => item.classList.toggle('active-stream', item === card));
        if (previousSerial !== activeSerial) {
            if (force) connect(card, true);
            else updateStreamingMode();
        } else {
            connect(card, force);
        }
        applyBrowserMic({ type: 'activate', serial: card.dataset.device, gesture: gesture === true });
    }

    const isDesktop = () => innerWidth > 700;

    // 收回一台（电脑上可以同时放大多台，各自收回）。
    function collapseCard(card) {
        if (!card.classList.contains('expanded')) return;
        card.classList.remove('expanded', 'narrow');
        if (!cards.some((item) => item.classList.contains('expanded'))) {
            backdrop.classList.remove('visible');
            document.body.classList.remove('has-expanded');
        }
        refitCards();
    }

    function collapseExpanded() {
        const was = cards.filter((card) => card.classList.contains('expanded'));
        cards.forEach((card) => card.classList.remove('expanded', 'narrow'));
        backdrop.classList.remove('visible');
        document.body.classList.remove('has-expanded');
        // 回到九宫格后重新排一下，免得放大时的位置把小窗挡住。
        if (was.length) refitCards();
    }

    // 九宫格小窗只看不操作；点小窗放大成操作窗口才能操作手机，避免误触。
    // 电脑上：在九宫格里原地放大成手机比例的窗口（大小跟侧栏小/中/大），可以同时放大多台并排操作；
    // 手机浏览器上：一次铺满一台。
    function sizeExpanded(card) {
        if (!card.classList.contains('expanded') || !isDesktop()) return;
        const aspect = card._lastAspect || 9 / 20;
        const gap = 12;
        // 和原来本地版的操作窗口一样：宽度就是侧栏「窗口大小」小/中/大（300/400/520），
        // 画面贴满卡片宽度、按手机比例算高度；屏幕放不下时按高度缩，宽度跟着缩，始终没有黑边。
        const header = card.querySelector('header');
        const chrome = Math.max(36, header?.offsetHeight || 36) + 36 + 22 + 2; // 标题栏 + 导航按钮 + 状态行 + 边框
        const available = Math.max(300, (grid.clientHeight || innerHeight - 52) - gap * 2);
        const target = Math.min(Number(tileSize.value) || 400, (grid.clientWidth || innerWidth) - gap * 2) - 2;
        const videoHeight = Math.min(available - chrome, target / aspect);
        const videoWidth = Math.round(videoHeight * aspect);
        const width = videoWidth + 2;
        const height = Math.round(videoWidth / aspect) + chrome;
        card.classList.toggle('narrow', width < 290);
        card.style.setProperty('--expanded-w', `${width}px`);
        card.style.setProperty('--expanded-h', `${height}px`);
    }

    function expand(card) {
        if (card.classList.contains('expanded')) return;
        if (!isDesktop()) collapseExpanded();
        card.classList.add('expanded');
        sizeExpanded(card);
        card._expandAt = Date.now();
        if (!isDesktop()) {
            backdrop.classList.add('visible');
            document.body.classList.add('has-expanded');
        } else {
            card.style.zIndex = String(++topLayer);
            refitCards();
            setTimeout(() => card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }), 520);
        }
        activate(card, false, true);
        // 布局定下来以后按全屏尺寸升到正常画质（只重连这一次）。
        setTimeout(() => {
            if (!card.classList.contains('expanded')) return;
            applyStreamProfile(card);
            card.querySelector('iframe')?.focus?.();
        }, 420);
    }

    function refreshAutoQuality() {
        if (quality.value !== 'auto') return;
        // Let the expand/collapse transition finish before measuring.
        setTimeout(() => cards.forEach(applyStreamProfile), 400);
    }

    function savePosition(card) {
        localStorage.setItem(`phone-position:${card.dataset.device}`, JSON.stringify({
            left: parseFloat(card.style.left) || 0,
            top: parseFloat(card.style.top) || 0,
        }));
    }

    function tileCards() {
        const gap = 12;
        const limit = Math.max(1, grid.clientWidth - gap);
        let left = gap;
        let top = gap;
        let rowHeight = 0;
        cards.filter((card) => !card.classList.contains('closed')).forEach((card) => {
            const width = card.offsetWidth;
            const height = card.offsetHeight;
            if (left > gap && left + width > limit) {
                left = gap;
                top += rowHeight + gap;
                rowHeight = 0;
            }
            card.style.left = `${left}px`;
            card.style.top = `${top}px`;
            card.style.zIndex = '';
            savePosition(card);
            left += width + gap;
            rowHeight = Math.max(rowHeight, height);
        });
        needsInitialLayout = false;
        localStorage.setItem('phone-layout-version', layoutVersion);
        grid.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
    }

    function scheduleTile() {
        clearTimeout(layoutTimer);
        layoutTimer = setTimeout(tileCards, 450);
    }

    function restorePosition(card, index) {
        if (!needsInitialLayout) {
            try {
                const saved = JSON.parse(localStorage.getItem(`phone-position:${card.dataset.device}`));
                if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
                    card.style.left = `${saved.left}px`;
                    card.style.top = `${saved.top}px`;
                    return;
                }
            } catch { /* use the default tiled position */ }
        }
        const width = Number(tileSize.value);
        const gap = 10;
        const columns = Math.max(1, Math.floor((grid.clientWidth - gap) / (width + gap)));
        card.style.left = `${gap + (index % columns) * (width + gap)}px`;
        card.style.top = `${gap + Math.floor(index / columns) * (width * 1.82 + gap)}px`;
    }

    function enableDragging(card) {
        const handle = card.querySelector('header');
        handle.addEventListener('pointerdown', (event) => {
            if (event.target.closest('button, input, label')) return;
            event.preventDefault();
            card.style.zIndex = String(++topLayer);
            const startLeft = parseFloat(card.style.left) || 0;
            const startTop = parseFloat(card.style.top) || 0;
            const startX = event.clientX;
            const startY = event.clientY;
            handle.setPointerCapture(event.pointerId);

            const move = (moveEvent) => {
                const maxLeft = Math.max(0, grid.clientWidth - card.offsetWidth);
                const maxTop = Math.max(0, grid.clientHeight - card.offsetHeight);
                card.style.left = `${Math.min(maxLeft, Math.max(0, startLeft + moveEvent.clientX - startX))}px`;
                card.style.top = `${Math.min(maxTop, Math.max(0, startTop + moveEvent.clientY - startY))}px`;
            };
            const end = () => {
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', end);
                handle.removeEventListener('pointercancel', end);
                savePosition(card);
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', end);
            handle.addEventListener('pointercancel', end);
        });
    }

    document.getElementById('collapse').addEventListener('click', () => app.classList.toggle('sidebar-collapsed'));
    document.getElementById('refresh-page').addEventListener('click', () => location.reload());
    const appPackage = document.getElementById('app-package');
    const appLibrary = document.getElementById('app-library');
    document.getElementById('install-app').addEventListener('click', () => {
        appLibrary.showModal();
        void loadAppLibrary();
    });
    document.getElementById('app-library-close').addEventListener('click', () => appLibrary.close());
    document.getElementById('app-local-install').addEventListener('click', () => appPackage.click());
    // 添加模拟器 / 云手机：地址存服务器，服务端后台自动 adb connect 并在重启后重连
    const remoteDialog = document.getElementById('remote-devices');
    const remoteList = document.getElementById('remote-devices-list');
    const REMOTE_STATE = { device: ['已连接', 'state-ok'], offline: ['离线，正在重连', 'state-bad'], unauthorized: ['未授权，请在设备上点允许调试', 'state-bad'], '': ['未连接，后台每 20 秒重试', 'state-bad'] };
    const remoteMessage = (text) => remoteList.replaceChildren(Object.assign(document.createElement('p'), { textContent: text }));
    async function remoteApi(method, body, path = '/api/remote-devices') {
        const response = await fetch(path, { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
    }
    function remoteItem(title, meta, stateText, stateClass, buttons) {
        const item = document.createElement('article');
        item.className = 'app-library-item';
        const info = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = title;
        name.title = title;
        const small = document.createElement('small');
        small.textContent = meta;
        const state = document.createElement('small');
        state.textContent = stateText;
        state.className = stateClass;
        info.append(name, small, state);
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:6px';
        actions.append(...buttons);
        item.append(info, actions);
        return item;
    }
    async function loadRemoteDevices() {
        try {
            const { devices } = await remoteApi('GET');
            if (!devices.length) return remoteMessage('还没有添加。BlueStacks 先在 设置 → 高级 里打开「Android 调试桥（ADB）」，再点下方扫描，或直接填 127.0.0.1:5555。');
            remoteList.replaceChildren(...devices.map((device) => {
                const [text, cls] = REMOTE_STATE[device.state] || [device.state, 'state-bad'];
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'secondary';
                remove.textContent = '删除';
                remove.addEventListener('click', async () => {
                    if (window.TX && !(await window.TX.confirm(`删除 ${device.address}？会断开连接，以后不再自动重连。`, { title: '删除设备', okText: '删除', danger: true }))) return;
                    remove.disabled = true;
                    try { await remoteApi('DELETE', { address: device.address }); notify('已删除', 'ok'); } catch (error) { notify(error.message, 'err'); }
                    void loadRemoteDevices();
                });
                return remoteItem(device.label || device.address, device.label ? device.address : 'ADB 网络设备', text, cls, [remove]);
            }));
        } catch (error) {
            remoteMessage(error instanceof Error ? error.message : '读取失败');
        }
    }
    async function addRemoteDevice(address, label) {
        const result = await remoteApi('POST', { address, label });
        if (result.connected) notify(`${result.address} 已连接，稍等几秒会出现在设备列表`, 'ok');
        else notify(`已保存 ${result.address}，但暂时连不上：${result.message || ''}。后台会自动重试`, 'err');
        await loadRemoteDevices();
    }
    document.getElementById('add-device').addEventListener('click', () => {
        remoteDialog.showModal();
        remoteMessage('正在读取…');
        void loadRemoteDevices();
    });
    document.getElementById('remote-devices-close').addEventListener('click', () => remoteDialog.close());
    remoteDialog.addEventListener('click', (event) => { if (event.target === remoteDialog) remoteDialog.close(); });
    document.getElementById('remote-device-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const addressInput = document.getElementById('remote-device-address');
        const labelInput = document.getElementById('remote-device-label');
        const submit = event.submitter || event.target.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
            await addRemoteDevice(addressInput.value.trim(), labelInput.value.trim());
            addressInput.value = '';
            labelInput.value = '';
        } catch (error) {
            notify(error.message, 'err');
        } finally {
            submit.disabled = false;
        }
    });
    document.getElementById('remote-devices-scan').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        remoteMessage('正在扫描本机模拟器端口…');
        try {
            const { found } = await remoteApi('POST', undefined, '/api/remote-devices/scan');
            if (!found.length) {
                remoteMessage('本机没扫到开着 ADB 的模拟器。请确认模拟器已启动，并在模拟器设置里打开 ADB 调试（BlueStacks：设置 → 高级 → Android 调试桥）。');
                return;
            }
            remoteList.replaceChildren(...found.map((hit) => {
                const add = document.createElement('button');
                add.type = 'button';
                add.textContent = hit.saved ? '已添加' : '添加';
                add.disabled = hit.saved;
                add.addEventListener('click', async () => {
                    add.disabled = true;
                    try { await addRemoteDevice(hit.address, hit.name); } catch (error) { notify(error.message, 'err'); add.disabled = false; }
                });
                return remoteItem(`${hit.name}${hit.model ? ` · ${hit.model}` : ''}`, hit.address, hit.saved ? (hit.state === 'device' ? '已保存，已连接' : '已保存，后台重连中') : hit.state === 'device' ? '已连接（未保存，重启会掉）' : '发现可连接', hit.state === 'device' ? 'state-ok' : '', [add]);
            }));
        } catch (error) {
            remoteMessage(error instanceof Error ? error.message : '扫描失败');
        } finally {
            button.disabled = false;
        }
    });
    appLibrary.addEventListener('click', (event) => {
        if (event.target === appLibrary) appLibrary.close();
    });
    appPackage.addEventListener('change', () => {
        const file = appPackage.files?.[0];
        appPackage.value = '';
        if (!file) return;
        if (!/\.apk$/i.test(file.name)) {
            notify('请选择 APK 安装包。', 'err');
            return;
        }
        const card = activeCard();
        if (!card) {
            notify('当前没有可用的云机。', 'err');
            return;
        }
        void uploadFiles(card, [file]);
    });
    document.getElementById('reconnect-all').addEventListener('click', async () => {
        await refreshDevices();
        updateStreamingMode(true);
    });
    document.getElementById('close-all').addEventListener('click', () => cards.forEach((card) => close(card, false)));
    document.getElementById('screen-off-all').addEventListener('click', () => void setAllScreenPower(false));
    document.getElementById('screen-on-all').addEventListener('click', () => void setAllScreenPower(true));
    syncToggle.addEventListener('click', () => {
        syncEnabled = !syncEnabled;
        localStorage.setItem('phone-sync-enabled', syncEnabled ? '1' : '0');
        updateSyncButton();
        updateStreamingMode();
    });
    document.getElementById('expand-first').addEventListener('click', () => cards[0] && expand(cards[0]));
    document.getElementById('tile-all').addEventListener('click', tileCards);
    videoModeButton.addEventListener('click', () => setStreamMode('video'));
    snapshotModeButton.addEventListener('click', () => setStreamMode('snapshot'));
    mobilePicker.addEventListener('change', () => {
        const card = cards.find((item) => item.dataset.device === mobilePicker.value);
        if (card) {
            if (syncEnabled) setMaster(card);
            // 手机上选哪台就铺满哪台；电脑上只切换当前手机，不自动放大（一进来保持九宫格）。
            if (isDesktop()) activate(card, false, true);
            else expand(card);
        }
    });
    tileSize.addEventListener('input', () => {
        document.documentElement.style.setProperty('--phone-width', `${tileSize.value}px`);
        sizeValue.value = tileSize.value;
        cards.forEach((card) => {
            if (!card.classList.contains('expanded') && !card.classList.contains('closed')) {
                card.style.width = '';
                card.style.height = '';
            }
        });
    });
    // 窗口大小只有小/中/大三档：每次切档只重新适配一次，不会边拖边重连。
    const sizeButtons = [...document.querySelectorAll('.size-switch [data-size]')];
    function paintSizeButtons() {
        for (const button of sizeButtons) {
            const on = button.dataset.size === tileSize.value;
            button.classList.toggle('active', on);
            button.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }
    try {
        const saved = localStorage.getItem('phone-tile-size');
        if (sizeButtons.some((button) => button.dataset.size === saved)) tileSize.value = saved;
    } catch { /* keep the default size */ }
    paintSizeButtons();
    document.documentElement.style.setProperty('--phone-width', `${tileSize.value}px`);
    for (const button of sizeButtons) {
        button.addEventListener('click', () => {
            if (tileSize.value === button.dataset.size) return;
            tileSize.value = button.dataset.size;
            try { localStorage.setItem('phone-tile-size', tileSize.value); } catch { /* per-browser convenience only */ }
            paintSizeButtons();
            tileSize.dispatchEvent(new Event('input'));
            tileSize.dispatchEvent(new Event('change'));
        });
    }
    tileSize.addEventListener('change', () => {
        cards.forEach(sizeExpanded);
        // No reconnect needed for a size change: refit each card to its stream,
        // and let 「自动」 step up later if the bigger window needs it.
        cards.forEach((card) => {
            if (card.classList.contains('closed')) return;
            card._videoAspect = 0;
            applyFrameState(card);
        });
        needsInitialLayout = true;
        scheduleTile();
    });
    // 手动换画质/帧率 = 重新按设定来，清掉网络自适应降下来的码率。
    const resetNetBitrate = () => cards.forEach((card) => { card._netBitrate = 0; card._episodeTimes = []; card._pinProfile = null; });
    quality.addEventListener('change', () => { resetNetBitrate(); updateStreamingMode(true); });
    fps.addEventListener('change', () => { resetNetBitrate(); updateStreamingMode(true); });
    backdrop.addEventListener('click', collapseExpanded);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && cards.some((card) => card.classList.contains('expanded'))) {
            collapseExpanded();
            return;
        }
        forwardDesktopKeyboard(event);
    });
    document.addEventListener('keyup', (event) => forwardDesktopKeyboard(event));
    let refitTimer = 0;
    window.addEventListener('resize', () => {
        clearTimeout(refitTimer);
        refitTimer = setTimeout(() => {
            refitCards();
            cards.forEach(sizeExpanded);
        }, 200);
        refreshAutoQuality();
    });
    const events = new EventSource('/api/events');
    events.addEventListener('update', (event) => {
        try {
            const { topic } = JSON.parse(event.data);
            if (topic === 'devices' || topic === 'rentals') void refreshDevices();
            if (topic === 'rentals') void updateAdminVisibility();
            if (topic === 'apks' && appLibrary.open) void loadAppLibrary();
            if (topic === 'devices' && remoteDialog.open && !remoteList.querySelector('button:not(.secondary)')) void loadRemoteDevices();
        } catch { /* reconnect delivers the next valid event */ }
    });
    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin || event.data?.type !== 'phone-browser-mic-state') return;
        const card = cards.find((item) => item.querySelector('iframe').contentWindow === event.source);
        if (!card) return;
        const reason = typeof event.data.phoneReason === 'string' ? event.data.phoneReason.slice(0, 200) : '';
        card._micPhone = { ready: event.data.deviceReady === true, reason };
        paintBrowserMic(card);
    });
    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin || event.data?.type !== 'phone-operation-log') return;
        const card = cards.find((item) => item.querySelector('iframe').contentWindow === event.source);
        if (card && typeof event.data.label === 'string' && event.data.label.length <= 40) logOperation(card, event.data.label);
    });
    updateSyncButton();
    // http://公网IP 不是安全上下文，没有 WebCodecs；再没有 MSE H.264（部分国产/内置浏览器内核）
    // 就根本放不了视频，只会卡在 connecting。这种浏览器直接用「抽帧远控」并说明原因。
    function canDecodeVideo() {
        if (window.isSecureContext && typeof window.VideoDecoder === 'function') return true;
        const MS = window.MediaSource || window.ManagedMediaSource;
        try { return !!MS && MS.isTypeSupported('video/mp4; codecs="avc1.42E01E"'); } catch { return false; }
    }
    if (!canDecodeVideo()) {
        streamMode = 'snapshot';
        const note = document.createElement('div');
        note.textContent = '这个浏览器不能播放视频流，已自动改用「抽帧远控」。想要流畅视频请用 Chrome 或 Edge 打开。';
        note.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:9999;padding:8px 12px;border-radius:8px;'
            + 'background:rgba(30,30,30,.92);color:#ffd27a;font:13px/1.5 system-ui,sans-serif;text-align:center;';
        note.addEventListener('click', () => note.remove());
        document.body.appendChild(note);
        setTimeout(() => note.remove(), 12000);
    }
    setStreamMode(streamMode, false);
    void updateAdminVisibility();
    try { localStorage.removeItem('phone-layout-mode'); } catch { /* ignore */ }
    refreshDevices();
})();
