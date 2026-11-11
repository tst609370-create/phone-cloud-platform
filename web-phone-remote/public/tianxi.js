/*
 * Tianxi UI 交互控件（静态页版）：Select、Tooltip、Toast、确认框、Slider 填充。
 * 对应 @tianxi/ui 的 Select / Tooltip / toast / Dialog；按 Tianxi 规矩，页面不出现原生下拉、
 * 原生 title 提示和 alert/confirm。
 *
 * 用法：
 *   <link rel="stylesheet" href="tianxi.css"> + <script src="tianxi.js"></script>（放在页面脚本之前）
 *   - <select data-tx-select> 自动换成 Tianxi Select；原生 select 仍是数据源（value / change 事件照旧）
 *   - 任何带 title 的元素悬停时显示 Tianxi Tooltip（title 会被转存到 data-tx-tip）
 *   - TX.toast(text, 'ok' | 'err' | 'info')、await TX.confirm(text, { title, okText, danger })
 *   - <input type="range" class="tx-slider"> 自动维护渐变填充
 */
(() => {
    if (window.TX) return;
    const doc = document;
    const mobileQuery = window.matchMedia('(max-width: 639px)');
    const CHEVRON = '<svg class="tx-select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
    let uid = 0;

    /* ------------------------------ Select ------------------------------ */
    let openSelect = null;

    function closeOpenSelect(focusTrigger) {
        if (!openSelect) return;
        const current = openSelect;
        openSelect = null;
        current.popover.remove();
        current.backdrop?.remove();
        current.trigger.setAttribute('aria-expanded', 'false');
        if (focusTrigger) current.trigger.focus();
    }

    function enhanceSelect(select) {
        if (select.dataset.txEnhanced) return;
        select.dataset.txEnhanced = '1';
        const wrap = doc.createElement('div');
        wrap.className = `tx-select ${select.dataset.txClass || ''}`.trim();
        if (select.id) wrap.dataset.for = select.id;
        const trigger = doc.createElement('button');
        trigger.type = 'button';
        trigger.className = 'tx-select-trigger';
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        const label = select.getAttribute('aria-label') || (select.id && doc.querySelector(`label[for="${select.id}"]`)?.textContent?.trim());
        if (label) trigger.setAttribute('aria-label', label);
        const value = doc.createElement('span');
        value.className = 'tx-select-value';
        trigger.append(value);
        trigger.insertAdjacentHTML('beforeend', CHEVRON);
        wrap.append(trigger);
        select.after(wrap);
        select.hidden = true;
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        if (select.id) {
            const forLabel = doc.querySelector(`label[for="${select.id}"]`);
            if (forLabel) forLabel.addEventListener('click', (event) => { event.preventDefault(); trigger.focus(); });
        }

        const visibleOptions = () => [...select.options].filter((option) => !option.hidden);
        const sync = () => {
            const option = select.options[select.selectedIndex];
            value.textContent = option ? option.textContent : (select.dataset.placeholder || '请选择');
            value.classList.toggle('placeholder', !option);
            trigger.disabled = select.disabled;
            wrap.hidden = select.dataset.txHidden === '1';
        };

        const proto = HTMLSelectElement.prototype;
        for (const key of ['value', 'selectedIndex']) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, key);
            Object.defineProperty(select, key, {
                configurable: true,
                get() { return descriptor.get.call(this); },
                set(next) { descriptor.set.call(this, next); sync(); },
            });
        }
        new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
        select.addEventListener('change', sync);

        function choose(option) {
            if (!option || option.disabled) return;
            const changed = select.value !== option.value;
            select.value = option.value;
            closeOpenSelect(true);
            if (changed) {
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        function open() {
            if (select.disabled) return;
            closeOpenSelect(false);
            const options = visibleOptions();
            const popover = doc.createElement('div');
            const listId = `tx-listbox-${++uid}`;
            popover.id = listId;
            popover.className = 'tx-popover tx-scroll';
            popover.setAttribute('role', 'listbox');
            trigger.setAttribute('aria-controls', listId);
            let backdrop = null;
            const sheet = mobileQuery.matches;
            if (sheet) {
                popover.classList.add('tx-sheet');
                backdrop = doc.createElement('div');
                backdrop.className = 'tx-sheet-backdrop';
                backdrop.addEventListener('pointerdown', (event) => { event.preventDefault(); closeOpenSelect(true); });
                doc.body.append(backdrop);
                if (label) {
                    const title = doc.createElement('div');
                    title.className = 'tx-sheet-title';
                    title.textContent = label;
                    popover.append(title);
                }
            }
            const items = options.map((option) => {
                const item = doc.createElement('div');
                item.className = 'tx-option';
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', String(option.selected));
                if (option.disabled) item.setAttribute('aria-disabled', 'true');
                const text = doc.createElement('span');
                text.textContent = option.textContent;
                item.append(text);
                item.insertAdjacentHTML('beforeend', CHECK);
                item.addEventListener('pointermove', () => highlight(items.indexOf(item)));
                item.addEventListener('click', () => choose(option));
                popover.append(item);
                return item;
            });
            if (!items.length) {
                const empty = doc.createElement('div');
                empty.className = 'tx-option';
                empty.setAttribute('aria-disabled', 'true');
                empty.textContent = '暂无选项';
                popover.append(empty);
            }
            doc.body.append(popover);
            let active = Math.max(0, options.findIndex((option) => option.selected));
            function highlight(index) {
                if (!items.length) return;
                active = (index + items.length) % items.length;
                items.forEach((item, i) => item.toggleAttribute('data-highlighted', i === active));
                items[active].scrollIntoView({ block: 'nearest' });
            }
            if (!sheet) {
                const rect = trigger.getBoundingClientRect();
                popover.style.minWidth = `${rect.width}px`;
                const below = window.innerHeight - rect.bottom - 12;
                const height = popover.offsetHeight;
                const left = Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8);
                popover.style.left = `${Math.max(8, left)}px`;
                if (height > below && rect.top > below) {
                    popover.style.top = `${Math.max(8, rect.top - 6 - height)}px`;
                    popover.style.transformOrigin = 'bottom left';
                } else {
                    popover.style.top = `${rect.bottom + 6}px`;
                }
            }
            highlight(active);
            trigger.setAttribute('aria-expanded', 'true');
            openSelect = {
                trigger, popover, backdrop,
                key(event) {
                    if (event.key === 'ArrowDown') highlight(active + 1);
                    else if (event.key === 'ArrowUp') highlight(active - 1);
                    else if (event.key === 'Home') highlight(0);
                    else if (event.key === 'End') highlight(items.length - 1);
                    else if (event.key === 'Enter' || event.key === ' ') choose(options[active]);
                    else if (event.key === 'Escape' || event.key === 'Tab') { closeOpenSelect(event.key === 'Escape'); return; }
                    else return;
                    event.preventDefault();
                },
            };
        }

        trigger.addEventListener('click', () => (openSelect?.trigger === trigger ? closeOpenSelect(false) : open()));
        trigger.addEventListener('keydown', (event) => {
            if (openSelect?.trigger === trigger) { openSelect.key(event); return; }
            if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
        });
        sync();
    }

    doc.addEventListener('pointerdown', (event) => {
        if (!openSelect) return;
        if (openSelect.popover.contains(event.target) || openSelect.trigger.contains(event.target)) return;
        closeOpenSelect(false);
    }, true);
    window.addEventListener('resize', () => closeOpenSelect(false));
    doc.addEventListener('scroll', (event) => {
        if (openSelect && !openSelect.popover.contains(event.target)) closeOpenSelect(false);
    }, true);

    /* ------------------------------ Tooltip ------------------------------ */
    let tip = null;
    let tipTarget = null;
    let tipTimer = 0;

    function hideTip() {
        clearTimeout(tipTimer);
        tip?.remove();
        tip = null;
        tipTarget = null;
    }

    function adoptTitle(element) {
        const title = element.getAttribute('title');
        if (title === null) return element.dataset.txTip || '';
        element.removeAttribute('title');
        if (title) {
            element.dataset.txTip = title;
            if (!element.hasAttribute('aria-label') && !element.textContent.trim()) element.setAttribute('aria-label', title);
        } else {
            delete element.dataset.txTip;
        }
        return title;
    }

    function showTip(element) {
        const text = adoptTitle(element);
        if (!text || element.matches('iframe')) return;
        hideTip();
        tipTarget = element;
        tipTimer = setTimeout(() => {
            if (tipTarget !== element || !element.isConnected) return;
            tip = doc.createElement('div');
            tip.className = 'tx-tooltip';
            tip.setAttribute('role', 'tooltip');
            tip.textContent = text;
            doc.body.append(tip);
            const rect = element.getBoundingClientRect();
            const width = tip.offsetWidth;
            const height = tip.offsetHeight;
            const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
            const top = rect.top - height - 8 >= 8 ? rect.top - height - 8 : rect.bottom + 8;
            tip.style.left = `${left}px`;
            tip.style.top = `${top}px`;
        }, 350);
    }

    const tipHost = (target) => (target instanceof Element ? target.closest('[title], [data-tx-tip]') : null);
    doc.addEventListener('pointerover', (event) => {
        if (event.pointerType === 'touch') return;
        const host = tipHost(event.target);
        if (host && host !== tipTarget) showTip(host);
        else if (!host) hideTip();
    });
    doc.addEventListener('pointerout', (event) => {
        if (tipTarget && !tipTarget.contains(event.relatedTarget)) hideTip();
    });
    doc.addEventListener('focusin', (event) => { const host = tipHost(event.target); if (host) showTip(host); });
    doc.addEventListener('focusout', hideTip);
    doc.addEventListener('pointerdown', hideTip, true);
    doc.addEventListener('scroll', hideTip, true);

    /* ------------------------------ Toast ------------------------------ */
    let toaster = null;
    function toast(text, tone = 'info', duration = 3200) {
        if (!toaster || !toaster.isConnected) {
            toaster = doc.createElement('div');
            toaster.className = 'tx-toaster';
            toaster.setAttribute('role', 'status');
            toaster.setAttribute('aria-live', 'polite');
            doc.body.append(toaster);
        }
        const item = doc.createElement('div');
        item.className = `tx-toast ${tone}`;
        const body = doc.createElement('span');
        body.textContent = String(text);
        item.append(body);
        toaster.append(item);
        const dismiss = () => { item.classList.add('leaving'); setTimeout(() => item.remove(), 160); };
        item.addEventListener('click', dismiss);
        setTimeout(dismiss, duration);
        return dismiss;
    }

    /* ------------------------------ Confirm ------------------------------ */
    function confirmDialog(message, options = {}) {
        return new Promise((resolve) => {
            const dialog = doc.createElement('dialog');
            dialog.className = 'tx-dialog';
            const title = doc.createElement('h3');
            title.textContent = options.title || '请确认';
            const text = doc.createElement('p');
            text.textContent = String(message);
            const actions = doc.createElement('div');
            actions.className = 'tx-dialog-actions';
            const cancel = doc.createElement('button');
            cancel.type = 'button';
            cancel.className = 'tx-btn tx-btn-secondary';
            cancel.textContent = options.cancelText || '取消';
            const ok = doc.createElement('button');
            ok.type = 'button';
            ok.className = `tx-btn ${options.danger ? 'tx-btn-danger' : 'tx-btn-primary'}`;
            ok.textContent = options.okText || '确定';
            actions.append(cancel, ok);
            dialog.append(title, text, actions);
            doc.body.append(dialog);
            let result = false;
            const finish = (value) => { result = value; dialog.close(); };
            cancel.addEventListener('click', () => finish(false));
            ok.addEventListener('click', () => finish(true));
            dialog.addEventListener('click', (event) => { if (event.target === dialog) finish(false); });
            dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
            dialog.showModal();
            ok.focus();
        });
    }

    /* ------------------------------ Slider ------------------------------ */
    function syncSlider(input) {
        const min = Number(input.min || 0);
        const max = Number(input.max || 100);
        const percent = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
        input.style.setProperty('--tx-fill', `${percent}%`);
    }
    doc.addEventListener('input', (event) => { if (event.target.matches?.('.tx-slider')) syncSlider(event.target); });

    function enhanceSlider(input) {
        if (input.dataset.txEnhanced) { syncSlider(input); return; }
        input.dataset.txEnhanced = '1';
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        Object.defineProperty(input, 'value', {
            configurable: true,
            get() { return descriptor.get.call(this); },
            set(next) { descriptor.set.call(this, next); syncSlider(this); },
        });
        syncSlider(input);
    }

    function enhance(root = doc) {
        root.querySelectorAll('select[data-tx-select]').forEach(enhanceSelect);
        root.querySelectorAll('.tx-slider').forEach(enhanceSlider);
    }

    window.TX = { toast, confirm: confirmDialog, enhance, enhanceSelect, syncSlider };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => enhance());
    else enhance();
})();
