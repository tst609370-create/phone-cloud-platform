(() => {
    const app = document.querySelector('.app');
    let cards = [];
    const quality = document.getElementById('quality');
    const fps = document.getElementById('fps');
    const tileSize = document.getElementById('tile-size');
    const sizeValue = document.getElementById('size-value');
    const backdrop = document.getElementById('viewer-backdrop');
    const grid = document.getElementById('phone-grid');
    const syncToggle = document.getElementById('sync-toggle');
    const mobilePicker = document.getElementById('mobile-device-picker');
    const workspace = document.querySelector('.workspace');
    const flatButton = document.getElementById('layout-flat');
    const carouselButton = document.getElementById('layout-carousel');
    const videoModeButton = document.getElementById('stream-video');
    const snapshotModeButton = document.getElementById('stream-snapshot');
    const layoutVersion = '20260822j';
    let topLayer = 10;
    let layoutTimer = 0;
    let carouselDrag = null;
    let carouselSuppressClickUntil = 0;
    let needsInitialLayout = localStorage.getItem('phone-layout-version') !== layoutVersion;
    let syncEnabled = localStorage.getItem('phone-sync-enabled') === '1';
    let masterSerial = localStorage.getItem('phone-sync-master') || '';
    let activeSerial = localStorage.getItem('phone-active-device') || '';
    let layoutMode = localStorage.getItem('phone-layout-mode') === 'flat' ? 'flat' : 'carousel';
    let streamMode = localStorage.getItem('phone-stream-mode') === 'video' ? 'video' : 'snapshot';
    let visibleDevices = [];
    let rentalByDevice = new Map();
    let rentalSignature = '';
    const desktopKeyboard = window.matchMedia?.('(any-hover: hover) and (any-pointer: fine)').matches ?? false;
    const nativeMacShell = new URLSearchParams(location.search).get('native') === 'mac'
        || localStorage.getItem('phone-native-shell') === 'mac';
    const adaptiveRemote = location.protocol === 'https:' && !nativeMacShell;
    if (new URLSearchParams(location.search).get('native') === 'mac') {
        localStorage.setItem('phone-native-shell', 'mac');
    }
    const autoArrange = true;
    if (nativeMacShell) {
        layoutMode = 'carousel';
        localStorage.setItem('phone-layout-mode', 'carousel');
        document.getElementById('reconnect-all').hidden = true;
        document.getElementById('expand-first').hidden = true;
        document.getElementById('refresh-page').hidden = false;
    }

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
            ['tools', '展开功能', '功能'],
            ['upload', '安装 APP 或导入图片', '＋'],
            ['reconnect', '重新连接', '↻'],
            ['fullscreen', '全屏', '⛶'],
            ['close', '关闭', '×'],
        ]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.action = action;
            button.title = label;
            button.textContent = icon;
            actions.appendChild(button);
        }
        header.append(number, title, state, rentalBadge, syncControls, actions);

        const frame = document.createElement('iframe');
        frame.title = `${name} 控制窗口`;
        frame.allow = 'clipboard-read; clipboard-write; fullscreen';
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
        card.append(header, lastFrame, frame, nativeInput, resume, phoneNav, operationStatus, fileInput);
        grid.appendChild(card);
        void refreshScreenLockButton(card);
        restorePosition(card, index);
        enableDragging(card);
        card.querySelector('[data-action="tools"]').addEventListener('click', () => {
            const open = card.classList.toggle('tools-open');
            card.querySelector('[data-action="tools"]').classList.toggle('active', open);
            card.querySelector('iframe').contentDocument?.body?.classList.toggle('tools-expanded', open);
            alignNativeInputLayer(card, card._nativeCanvas);
        });
        card.querySelector('[data-action="upload"]').addEventListener('click', () => fileInput.click());
        card.querySelector('[data-action="reconnect"]').addEventListener('click', () => activate(card, true));
        card.querySelector('[data-action="fullscreen"]').addEventListener('click', () => expand(card));
        card.querySelector('[data-action="close"]').addEventListener('click', () => close(card));
        master.addEventListener('change', () => master.checked && setMaster(card));
        follower.addEventListener('change', () => {
            localStorage.setItem(`phone-sync-target:${device.serial}`, follower.checked ? '1' : '0');
        });
        resume.addEventListener('click', () => activate(card));
        fileInput.addEventListener('change', () => {
            if (fileInput.files?.length) void uploadFiles(card, [...fileInput.files]);
            fileInput.value = '';
        });
        for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
            card.addEventListener(type, (event) => handleFileDrag(card, event));
        }
        card.addEventListener('click', () => {
            if (Date.now() < carouselSuppressClickUntil) return;
            if (layoutMode === 'carousel' && !card.classList.contains('carousel-active')) activate(card);
        });
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
            note.textContent = '✎';
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
    async function refreshDevices() {
        if (devicesRefreshing) {
            devicesRefreshQueued = true;
            return;
        }
        devicesRefreshing = true;
        try {
            const response = await fetch('/api/devices/connected', { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const devices = await response.json();
            visibleDevices = devices;
            const nextKey = devices.map((device) => device.serial).sort().join('|');
            const currentKey = cards.map((card) => card.dataset.device).sort().join('|');
            if (nextKey === currentKey) return;
            cards.forEach((card) => close(card, false));
            grid.replaceChildren();
            cards = devices.map(createCard);
            ensureSyncSelection();
            ensureActiveSelection();
            renderDeviceNav(devices);
            applyRentalBadges();
            document.getElementById('device-count').textContent = `${devices.length} 台设备`;
            if (layoutMode === 'carousel') layoutCarousel();
            else if (autoArrange || needsInitialLayout) scheduleTile();
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

    function videoProfile(card) {
        const requestedSize = Number(quality.value);
        const requestedFps = Number(fps.value);
        const active = card.dataset.device === activeSerial;
        const activeBitrate = requestedSize > 720 ? 1200000 : requestedSize > 480 ? 1000000 : 800000;
        return {
            bitrate: adaptiveRemote && !active ? 350000 : activeBitrate,
            maxFps: adaptiveRemote && !active ? Math.min(15, requestedFps) : requestedFps,
            maxSize: requestedSize,
        };
    }

    function streamUrl(card) {
        if (streamMode === 'snapshot') {
            const params = new URLSearchParams({
                device: card.dataset.device,
                interval: '0',
                ui: '20260823d',
            });
            return `snapshot.html?${params}`;
        }
        const profile = videoProfile(card);
        const params = new URLSearchParams({
            device: card.dataset.device,
            deviceKind: card.dataset.deviceKind || 'phone',
            codec: 'h264',
            bitrate: String(profile.bitrate),
            maxFps: String(profile.maxFps),
            maxSize: String(profile.maxSize),
            audio: 'false',
            secure: location.protocol === 'https:' ? 'true' : 'false',
            ui: '20260822x',
        });
        return `embed.html?${params}`;
    }

    function applyStreamProfile(card) {
        if (card.dataset.streaming !== '1') return;
        const frame = card.querySelector('iframe');
        try {
            const status = frame.contentDocument?.getElementById('status');
            if (!status || (!status.classList.contains('hidden') && !/^connected|^已连接/i.test(status.textContent))) return;
        } catch { return; }
        const message = streamMode === 'snapshot'
            ? { type: 'phone-frame-profile', intervalMs: 0 }
            : { type: 'phone-stream-profile', ...videoProfile(card) };
        const signature = JSON.stringify(message);
        if (card.dataset.streamProfile === signature) return;
        frame.contentWindow?.postMessage(message, location.origin);
        card.dataset.streamProfile = signature;
    }

    function setState(card, state, label) {
        const el = card.querySelector('.connection-state');
        el.className = `connection-state ${state}`;
        el.textContent = label;
        if (state === 'connected' || state === 'error') card.classList.remove('reconnecting');
    }

    function fitCardToPhone(card, canvas, toolbar) {
        if (layoutMode === 'carousel' || card.classList.contains('expanded') || card.classList.contains('closed') || !canvas.width || !canvas.height) return;
        const border = 2;
        const headerHeight = card.querySelector(':scope > header').offsetHeight;
        const footerHeight = card.querySelector('.phone-nav').offsetHeight;
        const toolbarWidth = toolbar?.ownerDocument?.body?.hasAttribute('data-embed-entry')
            ? 0
            : Math.ceil(toolbar?.getBoundingClientRect().width || 60);
        const maxWidth = Number(tileSize.value);
        const maxVideoWidth = Math.max(1, maxWidth - toolbarWidth - border);
        const maxVideoHeight = Math.max(1, Math.min(maxWidth * 1.82 - headerHeight - footerHeight - border, innerHeight - 60 - headerHeight - footerHeight - border));
        const ratio = canvas.width / canvas.height;
        const videoWidth = Math.min(maxVideoWidth, maxVideoHeight * ratio);
        const videoHeight = videoWidth / ratio;
        card.style.width = `${Math.ceil(videoWidth + toolbarWidth + border)}px`;
        card.style.height = `${Math.ceil(videoHeight + headerHeight + footerHeight + border)}px`;
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
            const doc = card.querySelector('iframe').contentDocument;
            const status = doc?.getElementById('status');
            if (!status) return;
            doc.documentElement.setAttribute('data-theme', 'dark');
            doc.body.classList.toggle('tools-expanded', card.classList.contains('tools-open'));
            installSyncBridge(card, doc);
            const canvas = doc.querySelector('.touch-layer');
            fitStreamToFrame(card, doc, canvas);
            installNativeInputBridge(card, canvas);
            const aspect = canvas?.width / canvas?.height;
            if (aspect && aspect !== card._videoAspect) {
                card._videoAspect = aspect;
                fitCardToPhone(card, canvas, doc.querySelector('.control-buttons-list'));
                if (layoutMode === 'carousel') layoutCarousel();
                else if (autoArrange || needsInitialLayout) scheduleTile();
            }
            if (status.classList.contains('hidden') || /^connected\b/i.test(status.textContent)) setState(card, 'connected', '已连接');
            else if (/error|disconnected/i.test(status.textContent)) setState(card, 'error', '连接失败');
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
        const card = cards.find((item) => item.dataset.device === activeSerial && !item.classList.contains('closed'));
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
            if (card.dataset.device !== activeSerial) activate(card);
        }, true);
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
            alert(error instanceof Error ? error.message : '锁屏/解锁失败');
        } finally {
            button.disabled = false;
        }
    }

    async function setAllScreenPower(on) {
        const results = await Promise.allSettled(cards.map((card) => setDeviceScreenPower(card, on)));
        const failed = results.filter((result) => result.status === 'rejected');
        if (failed.length) alert(`${failed.length} 台手机${on ? '唤醒' : '熄屏'}失败，请检查 USB 连接。`);
    }

    function captureLastFrame(card) {
        try {
            const doc = card.querySelector('iframe').contentDocument;
            const canvas = [...(doc?.querySelectorAll('canvas') || [])].find((item) => !item.classList.contains('touch-layer'));
            if (canvas?.width && canvas?.height) card.querySelector('.last-frame').src = canvas.toDataURL('image/jpeg', 0.72);
        } catch { /* keep the previous frame if this decoder cannot be sampled */ }
    }

    function connect(card, force = false) {
        if (card.dataset.streaming === '1' && !force) return;
        if (card.dataset.streaming === '1' && force) {
            captureLastFrame(card);
            if (card.querySelector('.last-frame').src) card.classList.add('reconnecting');
        }
        card.classList.remove('closed', 'paused');
        card.dataset.streaming = '1';
        delete card.dataset.streamProfile;
        card._videoAspect = 0;
        if (layoutMode !== 'carousel') {
            card.style.width = '';
            card.style.height = '';
        }
        setState(card, '', '连接中');
        card.querySelector('iframe').src = streamUrl(card);
        watchState(card);
    }

    function close(card, update = true) {
        clearFrameObservers(card);
        card.querySelector('iframe').src = 'about:blank';
        card.dataset.streaming = '0';
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
        if (layoutMode === 'carousel') layoutCarousel();
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
        localStorage.setItem('phone-stream-mode', mode);
        videoModeButton.classList.toggle('active', mode === 'video');
        snapshotModeButton.classList.toggle('active', mode === 'snapshot');
        videoModeButton.setAttribute('aria-pressed', mode === 'video' ? 'true' : 'false');
        snapshotModeButton.setAttribute('aria-pressed', mode === 'snapshot' ? 'true' : 'false');
        if (reconnect && changed) updateStreamingMode(true);
    }

    function activate(card, force = false) {
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
        if (layoutMode === 'carousel') layoutCarousel();
    }

    function collapseExpanded() {
        cards.forEach((card) => card.classList.remove('expanded'));
        backdrop.classList.remove('visible');
        if (layoutMode === 'carousel') layoutCarousel();
    }

    function expand(card) {
        collapseExpanded();
        activate(card);
        card.classList.add('expanded');
        backdrop.classList.add('visible');
    }

    function savePosition(card) {
        localStorage.setItem(`phone-position:${card.dataset.device}`, JSON.stringify({
            left: parseFloat(card.style.left) || 0,
            top: parseFloat(card.style.top) || 0,
        }));
    }

    function tileCards() {
        if (layoutMode === 'carousel') {
            layoutCarousel();
            return;
        }
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

    function layoutCarousel() {
        const openCards = cards.filter((card) => !card.classList.contains('closed'));
        if (!openCards.length) return;
        let center = openCards.findIndex((card) => card.dataset.device === activeSerial);
        if (center < 0) center = 0;
        const fallbackWidth = Math.min(420, Math.max(360, Number(tileSize.value) + 60));
        const height = Math.min(fallbackWidth * 1.82, Math.max(420, grid.clientHeight - 76));
        const cardWidth = (card) => card._videoAspect
            ? Math.min(480, Math.max(260, Math.round((height - 72) * card._videoAspect) + 2))
            : fallbackWidth;
        const step = Math.min(cardWidth(openCards[center]) * .82, Math.max(170, grid.clientWidth / 5.2));
        openCards.forEach((card, index) => {
            let offset = index - center;
            if (offset > openCards.length / 2) offset -= openCards.length;
            if (offset < -openCards.length / 2) offset += openCards.length;
            const distance = Math.abs(offset);
            const angle = offset === 0 ? 0 : offset > 0 ? -30 : 30;
            const scale = Math.max(.62, 1 - distance * .12);
            const width = cardWidth(card);
            card.classList.toggle('carousel-active', offset === 0);
            card.style.width = `${width}px`;
            card.style.height = `${height}px`;
            card.style.zIndex = String(100 - distance);
            if (offset === 0) {
                // WKWebView does not reliably hit-test an iframe below a 3D
                // transformed ancestor. Keep the active phone visually centred
                // with real coordinates so its touch canvas receives mouse input.
                card.style.left = `${Math.round((grid.clientWidth - width) / 2)}px`;
                card.style.top = `${Math.round((grid.clientHeight - height) / 2 - 20)}px`;
                card.style.transform = 'none';
            } else {
                card.style.left = '50%';
                card.style.top = 'calc(50% - 20px)';
                // Keep perspective on each side card instead of the grid. A
                // perspective ancestor breaks iframe hit-testing in WebKit.
                card.style.transform = `perspective(1500px) translate(-50%, -50%) translateX(calc(${offset * step}px + var(--carousel-drag, 0px))) translateZ(${-distance * 150}px) rotateY(${angle}deg) scale(${scale})`;
            }
        });
    }

    function rotateCarousel(direction) {
        const openCards = cards.filter((card) => !card.classList.contains('closed'));
        if (!openCards.length) return;
        const current = Math.max(0, openCards.findIndex((card) => card.dataset.device === activeSerial));
        activate(openCards[(current + direction + openCards.length) % openCards.length]);
    }

    function setLayoutMode(mode) {
        layoutMode = mode;
        localStorage.setItem('phone-layout-mode', mode);
        const carousel = mode === 'carousel';
        workspace.classList.toggle('carousel-layout', carousel);
        grid.classList.toggle('carousel-mode', carousel);
        flatButton.classList.toggle('active', !carousel);
        carouselButton.classList.toggle('active', carousel);
        flatButton.setAttribute('aria-pressed', carousel ? 'false' : 'true');
        carouselButton.setAttribute('aria-pressed', carousel ? 'true' : 'false');
        cards.forEach((card) => {
            card.classList.remove('carousel-active');
            card.style.removeProperty('transform');
            card._videoAspect = 0;
        });
        if (carousel) layoutCarousel();
        else {
            cards.forEach((card, index) => {
                card.style.width = '';
                card.style.height = '';
                restorePosition(card, index);
            });
            needsInitialLayout = true;
            scheduleTile();
        }
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
            if (layoutMode === 'carousel' || event.target.closest('button, input, label') || card.classList.contains('expanded')) return;
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
    document.getElementById('install-app').addEventListener('click', () => appPackage.click());
    appPackage.addEventListener('change', () => {
        const file = appPackage.files?.[0];
        appPackage.value = '';
        if (!file) return;
        if (!/\.apk$/i.test(file.name)) {
            alert('请选择 APK 安装包。');
            return;
        }
        const card = cards.find((item) => item.dataset.device === activeSerial && !item.classList.contains('closed'))
            || cards.find((item) => !item.classList.contains('closed'));
        if (!card) {
            alert('当前没有可用的云机。');
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
    flatButton.addEventListener('click', () => setLayoutMode('flat'));
    carouselButton.addEventListener('click', () => setLayoutMode('carousel'));
    videoModeButton.addEventListener('click', () => setStreamMode('video'));
    snapshotModeButton.addEventListener('click', () => setStreamMode('snapshot'));
    document.getElementById('carousel-prev').addEventListener('click', () => rotateCarousel(-1));
    document.getElementById('carousel-next').addEventListener('click', () => rotateCarousel(1));
    grid.addEventListener('pointerdown', (event) => {
        if (layoutMode !== 'carousel' || event.button !== 0 || event.target.closest('iframe, button, input, select, label, a')) return;
        event.preventDefault();
        document.getSelection()?.removeAllRanges();
        carouselDrag = { id: event.pointerId, startX: event.clientX, delta: 0 };
        grid.classList.add('carousel-dragging');
        grid.setPointerCapture(event.pointerId);
    });
    grid.addEventListener('pointermove', (event) => {
        if (carouselDrag?.id !== event.pointerId) return;
        carouselDrag.delta = Math.max(-grid.clientWidth * .35, Math.min(grid.clientWidth * .35, event.clientX - carouselDrag.startX));
        grid.style.setProperty('--carousel-drag', `${carouselDrag.delta}px`);
    });
    const endCarouselDrag = (event) => {
        if (carouselDrag?.id !== event.pointerId) return;
        const delta = carouselDrag.delta;
        const threshold = Math.min(70, grid.clientWidth * .12);
        carouselDrag = null;
        grid.classList.remove('carousel-dragging');
        if (grid.hasPointerCapture(event.pointerId)) grid.releasePointerCapture(event.pointerId);
        if (Math.abs(delta) >= threshold) {
            carouselSuppressClickUntil = Date.now() + 300;
            rotateCarousel(delta < 0 ? 1 : -1);
        } else {
            layoutCarousel();
        }
        requestAnimationFrame(() => grid.style.removeProperty('--carousel-drag'));
    };
    grid.addEventListener('pointerup', endCarouselDrag);
    grid.addEventListener('pointercancel', endCarouselDrag);
    mobilePicker.addEventListener('change', () => {
        const card = cards.find((item) => item.dataset.device === mobilePicker.value);
        if (card) {
            if (syncEnabled) setMaster(card);
            activate(card);
        }
    });
    tileSize.addEventListener('input', () => {
        document.documentElement.style.setProperty('--phone-width', `${tileSize.value}px`);
        sizeValue.value = tileSize.value;
        if (layoutMode === 'carousel') {
            layoutCarousel();
            return;
        }
        cards.forEach((card) => {
            if (!card.classList.contains('expanded') && !card.classList.contains('closed')) {
                card.style.width = '';
                card.style.height = '';
            }
        });
    });
    tileSize.addEventListener('change', () => {
        updateStreamingMode(true);
        needsInitialLayout = true;
        scheduleTile();
    });
    quality.addEventListener('change', () => updateStreamingMode(true));
    fps.addEventListener('change', () => updateStreamingMode(true));
    backdrop.addEventListener('click', collapseExpanded);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && cards.some((card) => card.classList.contains('expanded'))) {
            collapseExpanded();
            return;
        }
        if (forwardDesktopKeyboard(event)) return;
        if (layoutMode === 'carousel' && !event.target.closest('input, select, textarea')) {
            if (event.key === 'ArrowLeft') rotateCarousel(-1);
            if (event.key === 'ArrowRight') rotateCarousel(1);
        }
    });
    document.addEventListener('keyup', (event) => forwardDesktopKeyboard(event));
    window.addEventListener('resize', () => {
        if (layoutMode === 'carousel') layoutCarousel();
        else if (autoArrange) scheduleTile();
    });
    const events = new EventSource('/api/events');
    events.addEventListener('update', (event) => {
        try {
            const { topic } = JSON.parse(event.data);
            if (topic === 'devices' || topic === 'rentals') void refreshDevices();
            if (topic === 'rentals') void updateAdminVisibility();
        } catch { /* reconnect delivers the next valid event */ }
    });
    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin || event.data?.type !== 'phone-operation-log') return;
        const card = cards.find((item) => item.querySelector('iframe').contentWindow === event.source);
        if (card && typeof event.data.label === 'string' && event.data.label.length <= 40) logOperation(card, event.data.label);
    });
    updateSyncButton();
    setStreamMode(streamMode, false);
    void updateAdminVisibility();
    setLayoutMode(layoutMode);
    refreshDevices();
})();
