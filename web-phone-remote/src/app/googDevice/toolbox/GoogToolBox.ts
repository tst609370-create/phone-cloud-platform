import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import type { BasePlayer } from '../../player/BasePlayer';
import { ToolBox } from '../../toolbox/ToolBox';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxCheckbox } from '../../toolbox/ToolBoxCheckbox';
import type { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import SvgImage from '../../ui/SvgImage';
import KeyEvent from '../android/KeyEvent';
import type { StreamClientScrcpy } from '../client/StreamClientScrcpy';

const BUTTONS = [
    {
        title: '电源',
        code: KeyEvent.KEYCODE_POWER,
        icon: SvgImage.Icon.POWER,
    },
    {
        title: '音量加',
        code: KeyEvent.KEYCODE_VOLUME_UP,
        icon: SvgImage.Icon.VOLUME_UP,
    },
    {
        title: '音量减',
        code: KeyEvent.KEYCODE_VOLUME_DOWN,
        icon: SvgImage.Icon.VOLUME_DOWN,
    },
    {
        title: '返回',
        code: KeyEvent.KEYCODE_BACK,
        icon: SvgImage.Icon.BACK,
    },
    {
        title: '主页',
        code: KeyEvent.KEYCODE_HOME,
        icon: SvgImage.Icon.HOME,
    },
    {
        title: '多任务',
        code: KeyEvent.KEYCODE_APP_SWITCH,
        icon: SvgImage.Icon.OVERVIEW,
    },
];

export class GoogToolBox extends ToolBox {
    protected constructor(list: ToolBoxElement<any>[]) {
        super(list);
    }

    public static createToolBox(
        udid: string,
        player: BasePlayer,
        client: StreamClientScrcpy,
        deviceKind?: 'phone' | 'tablet' | 'tv',
    ): GoogToolBox {
        const playerName = player.getName();
        const list = BUTTONS.slice();
        const handler = <K extends keyof HTMLElementEventMap, T extends HTMLElement>(
            type: K,
            element: ToolBoxElement<T>,
        ) => {
            if (!element.optional?.['code']) {
                return;
            }
            const { code } = element.optional;
            const action = type === 'mousedown' ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP;
            const event = new KeyCodeControlMessage(action, code, 0, 0);
            client.sendMessage(event);
        };
        const elements: ToolBoxElement<any>[] = list.map((item) => {
            const button = new ToolBoxButton(item.title, item.icon, {
                code: item.code,
            });
            if (item.code === KeyEvent.KEYCODE_POWER) {
                button.addEventListener('click', async () => {
                    try {
                        const stateResponse = await fetch(`/api/devices/screen-state?udid=${encodeURIComponent(udid)}`);
                        if (!stateResponse.ok) throw new Error('读取屏幕状态失败');
                        const state = (await stateResponse.json()) as { awake: boolean };
                        const powerResponse = await fetch('/api/devices/sleep-wake', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ udid, action: state.awake ? 'sleep' : 'wake' }),
                        });
                        if (!powerResponse.ok) throw new Error('电源操作失败');
                        const result = (await powerResponse.json()) as { awake: boolean };
                        client.sendMessage(CommandControlMessage.createSetScreenPowerModeCommand(result.awake));
                    } catch (error) {
                        console.error('[GoogToolBox] screen power failed:', error);
                    }
                });
            } else {
                button.addEventListener('mousedown', handler);
                button.addEventListener('mouseup', handler);
            }
            return button;
        });
        if (player.supportsScreenshot) {
            const screenshot = new ToolBoxButton('截图', SvgImage.Icon.CAMERA);
            screenshot.addEventListener('click', () => {
                player.createScreenshot(client.getDeviceName());
            });
            elements.push(screenshot);
        }

        const keyboard = new ToolBoxCheckbox(
            '软键盘',
            SvgImage.Icon.KEYBOARD,
            `capture_keyboard_${udid}_${playerName}`,
        );
        keyboard.getElement().checked = true;
        keyboard.addEventListener('click', (_, el) => {
            const element = el.getElement();
            client.setHandleKeyboardEvents(element.checked);
        });
        elements.push(keyboard);

        const uhid = new ToolBoxCheckbox(
            '硬件键鼠',
            SvgImage.Icon.KEYBOARD,
            `uhid_input_${udid}_${playerName}`,
        );
        uhid.addEventListener('click', (_, el) => {
            const element = el.getElement();
            client.toggleUhid(element.checked);
        });
        elements.push(uhid);

        const stats = new ToolBoxCheckbox(
            '性能统计',
            SvgImage.Icon.BAR_CHART,
            `quality_stats_${udid}_${playerName}`,
        );
        stats.addEventListener('click', (_, el) => {
            player.setShowQualityStats(el.getElement().checked);
        });
        elements.push(stats);

        // D-pad mode (unchecked) vs Touch mode (checked)
        const DPAD_TITLE = '方向键模式（点击切换触控）';
        const TOUCH_TITLE = '触控模式（点击切换方向键）';
        const inputMode = new ToolBoxCheckbox(
            DPAD_TITLE,
            { off: SvgImage.Icon.DPAD, on: SvgImage.Icon.TOUCH_HAND },
            `input_mode_${udid}_${playerName}`,
        );
        const inputModeLabel = inputMode.getAllElements()[1]!;

        // Touch is the safe default for embedded phone views. Only an explicitly
        // classified TV starts in D-pad mode.
        const startInTouch = deviceKind !== 'tv';
        if (startInTouch) {
            inputMode.getElement().checked = true;
            client.setDpadMode(false);
            inputModeLabel.title = TOUCH_TITLE;
        } else {
            client.setDpadMode(true);
        }

        inputMode.addEventListener('click', (_, el) => {
            const touchMode = el.getElement().checked;
            client.setDpadMode(!touchMode);
            inputModeLabel.title = touchMode ? TOUCH_TITLE : DPAD_TITLE;
        });
        elements.push(inputMode);

        const refresh = new ToolBoxButton('重连画面', SvgImage.Icon.REFRESH);
        refresh.addEventListener('click', () => {
            client.refreshStream();
        });
        elements.push(refresh);

        // GET: pull device clipboard to host
        const clipGet = new ToolBoxButton('复制手机文字', SvgImage.Icon.CLIPBOARD_GET);
        clipGet.addEventListener('click', () => {
            client.sendMessage(CommandControlMessage.createGetClipboardCommand());
        });
        elements.push(clipGet);

        // SET: push host clipboard to device
        const clipSet = new ToolBoxButton('粘贴电脑文字', SvgImage.Icon.CLIPBOARD_SET);
        clipSet.addEventListener('click', async () => {
            if (!navigator.clipboard?.readText) {
                console.error('[GoogToolBox] navigator.clipboard.readText unavailable');
                return;
            }
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    client.sendMessage(CommandControlMessage.createSetClipboardCommand(text));
                }
            } catch (err) {
                console.error('[GoogToolBox] clipboard read failed:', err);
            }
        });
        elements.push(clipSet);

        return new GoogToolBox(elements);
    }
}
