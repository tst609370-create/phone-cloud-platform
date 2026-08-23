(() => {
    const params = new URLSearchParams(location.search);
    const udid = params.get('device');
    const status = document.getElementById('status');
    const screen = document.getElementById('screen');
    const touch = document.getElementById('touch');
    const decoder = document.getElementById('decoder');
    const context = screen.getContext('2d', { alpha: false });
    let intervalMs = Math.max(0, Number(params.get('interval')) || 0);
    let etag = '';
    let timer = 0;
    let busy = false;
    let forceQueued = false;
    let objectUrl = '';
    let pointer = null;
    let lastTap = null;
    let inputSequence = 0;
    let settleTimer = 0;

    const showError = (message) => {
        status.textContent = message;
        status.classList.remove('hidden');
        status.style.color = '#ff8992';
    };

    const schedule = (delay = intervalMs) => {
        clearTimeout(timer);
        if (intervalMs <= 0) return;
        timer = setTimeout(() => void refreshFrame(), delay);
    };

    const paintFrame = async (blob, nextEtag = '') => {
        const nextUrl = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => {
            decoder.onload = resolve;
            decoder.onerror = reject;
            decoder.src = nextUrl;
        });
        screen.width = touch.width = decoder.naturalWidth;
        screen.height = touch.height = decoder.naturalHeight;
        context.drawImage(decoder, 0, 0);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = nextUrl;
        if (nextEtag) etag = nextEtag;
        status.textContent = `已连接 · 抽帧 · ${screen.width}×${screen.height}`;
        status.classList.add('hidden');
    };

    async function refreshFrame(force = false) {
        if (!udid) {
            showError('缺少设备编号');
            return;
        }
        if (busy) {
            forceQueued ||= force;
            return;
        }
        busy = true;
        clearTimeout(timer);
        try {
            const query = new URLSearchParams({ udid });
            if (force) query.set('fresh', '1');
            const headers = etag ? { 'If-None-Match': etag } : {};
            const response = await fetch(`/api/devices/frame?${query}`, { headers, cache: 'no-store' });
            if (response.status !== 304) {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                await paintFrame(await response.blob(), response.headers.get('ETag') || '');
            }
            if (response.status === 304) status.classList.add('hidden');
        } catch (error) {
            showError(`画面获取失败 · ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            busy = false;
            if (forceQueued) {
                forceQueued = false;
                queueMicrotask(() => void refreshFrame(true));
            } else {
                schedule();
            }
        }
    }

    async function sendInput(action, label = '已操作') {
        const sequence = ++inputSequence;
        clearTimeout(settleTimer);
        parent.postMessage({ type: 'phone-operation-log', label }, location.origin);
        const response = await fetch('/api/devices/input?frame=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ udid, ...action }),
        });
        if (!response.ok) throw new Error(`操作失败 HTTP ${response.status}`);
        if (sequence !== inputSequence) return;
        await paintFrame(await response.blob(), response.headers.get('ETag') || '');
        settleTimer = setTimeout(() => void refreshFrame(true), action.action === 'swipe' ? 450 : 240);
    }

    const pointFromEvent = (event) => {
        const rect = touch.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(touch.width, Math.round((event.clientX - rect.left) * touch.width / rect.width))),
            y: Math.max(0, Math.min(touch.height, Math.round((event.clientY - rect.top) * touch.height / rect.height))),
        };
    };

    touch.addEventListener('pointerdown', (event) => {
        if (!touch.width || !touch.height) return;
        event.preventDefault();
        touch.setPointerCapture?.(event.pointerId);
        pointer = { id: event.pointerId, start: pointFromEvent(event), end: pointFromEvent(event), at: performance.now() };
    });
    touch.addEventListener('pointermove', (event) => {
        if (pointer?.id !== event.pointerId) return;
        event.preventDefault();
        pointer.end = pointFromEvent(event);
    });
    const finishPointer = (event) => {
        if (pointer?.id !== event.pointerId) return;
        event.preventDefault();
        pointer.end = pointFromEvent(event);
        const current = pointer;
        pointer = null;
        const distance = Math.hypot(current.end.x - current.start.x, current.end.y - current.start.y);
        const duration = Math.max(50, Math.min(1500, Math.round(performance.now() - current.at)));
        const action = distance < 10
            ? { action: 'tap', x: current.end.x, y: current.end.y }
            : { action: 'swipe', x: current.start.x, y: current.start.y, x2: current.end.x, y2: current.end.y, duration };
        let label;
        if (distance < 10) {
            const liked = lastTap && performance.now() - lastTap.at < 420 && Math.hypot(current.end.x - lastTap.x, current.end.y - lastTap.y) < 60;
            label = liked ? '已点赞' : '已点击屏幕';
            lastTap = liked ? null : { ...current.end, at: performance.now() };
        } else {
            const dx = current.end.x - current.start.x;
            const dy = current.end.y - current.start.y;
            label = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? '已切换下一条视频' : '已切换上一条视频') : '已左右滑动';
        }
        void sendInput(action, label).catch((error) => showError(error.message));
    };
    touch.addEventListener('pointerup', finishPointer);
    touch.addEventListener('pointercancel', finishPointer);
    touch.addEventListener('wheel', (event) => {
        event.preventDefault();
        const center = pointFromEvent(event);
        const distance = Math.max(80, Math.min(touch.height * .45, Math.abs(event.deltaY) * 2));
        const direction = event.deltaY > 0 ? -1 : 1;
        void sendInput({ action: 'swipe', x: center.x, y: center.y, x2: center.x, y2: center.y + distance * direction, duration: 180 }, event.deltaY > 0 ? '已切换下一条视频' : '已切换上一条视频')
            .catch((error) => showError(error.message));
    }, { passive: false });

    const keyMap = { Backspace: 'delete', Enter: 'enter', Escape: 'back' };
    document.addEventListener('keydown', (event) => {
        if (event.repeat) return;
        if (keyMap[event.key]) {
            event.preventDefault();
            void sendInput({ action: 'key', key: keyMap[event.key] }, event.key === 'Escape' ? '已返回' : event.key === 'Enter' ? '已确认' : '已删除输入').catch((error) => showError(error.message));
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            void sendInput({ action: 'text', text: event.key }, '已输入文字').catch((error) => showError(error.message));
        }
    });

    for (const [title, key] of [['返回', 'back'], ['主页', 'home'], ['多任务', 'recent']]) {
        document.querySelector(`button[title="${title}"]`).addEventListener('click', () => {
            const label = key === 'back' ? '已返回' : key === 'home' ? '已回到主页' : '已打开多任务';
            void sendInput({ action: 'key', key }, label).catch((error) => showError(error.message));
        });
    }
    document.querySelector('button[title="截图"]').addEventListener('click', () => {
        screen.toBlob((blob) => {
            if (!blob) return;
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `${udid}-${Date.now()}.png`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        });
    });

    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin) return;
        if (event.data?.type === 'phone-frame-profile') {
            intervalMs = Math.max(0, Math.min(10_000, Number(event.data.intervalMs) || 0));
            schedule();
        }
        if (event.data?.type === 'phone-display-power') setTimeout(() => void refreshFrame(true), 180);
    });
    void refreshFrame(true);
})();
