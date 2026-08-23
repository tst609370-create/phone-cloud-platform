import type { ControlMessage } from '../controlMessage/ControlMessage';
import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';
import { ScrollControlMessage } from '../controlMessage/ScrollControlMessage';
import type { TouchControlMessage } from '../controlMessage/TouchControlMessage';
import KeyEvent from '../googDevice/android/KeyEvent';
import MotionEvent from '../MotionEvent';
import type { BasePlayer } from '../player/BasePlayer';
import type ScreenInfo from '../ScreenInfo';
import { type InteractionEvents, InteractionHandler, type KeyEventNames } from './InteractionHandler';
import { shouldHandleMultiTouchKey } from './multiTouchKey';

const TAG = '[FeaturedTouchHandler]';

export interface InteractionHandlerListener {
    sendMessage: (message: ControlMessage) => void;
}

export class FeaturedInteractionHandler extends InteractionHandler {
    private static readonly directListenerOptions: AddEventListenerOptions = { passive: false };
    private static readonly touchEventsNames: InteractionEvents[] = [
        'touchstart',
        'touchend',
        'touchmove',
        'touchcancel',
        'pointerdown',
        'pointerup',
        'pointermove',
        'pointercancel',
        'mousedown',
        'mouseup',
        'mousemove',
        'wheel',
    ];
    private static readonly keyEventsNames: KeyEventNames[] = ['keydown', 'keyup'];
    public static SCROLL_EVENT_THROTTLING_TIME = 30;
    public static DPAD_SCROLL_DEBOUNCE_TIME = 400; // cooldown after first fire, absorbs hardware burst
    private readonly storedFromMouseEvent = new Map<number, TouchControlMessage>();
    private readonly storedFromTouchEvent = new Map<number, TouchControlMessage>();
    private readonly storedFromPointerEvent = new Map<number, TouchControlMessage>();
    private readonly handledEvents = new WeakSet<Event>();
    private lastPointerMouseEvent = 0;
    private lastPointerTouchEvent = 0;
    private lastScrollEvent?: { time: number; hScroll: number; vScroll: number };
    private dpadScrollCooldown = false;
    private dpadScrollTimer?: ReturnType<typeof setTimeout>;
    // Phones and tablets are the primary target. Default to coordinate touch so
    // input still works if an embedded WebKit view misses the toolbox seed step.
    // TV callers explicitly opt back into D-pad mode from GoogToolBox.
    private _dpadMode = false;

    constructor(
        player: BasePlayer,
        public readonly listener: InteractionHandlerListener,
    ) {
        super(player, FeaturedInteractionHandler.touchEventsNames, FeaturedInteractionHandler.keyEventsNames);
        FeaturedInteractionHandler.touchEventsNames.forEach((eventName) => {
            this.tag.addEventListener(eventName, this.onDirectInteraction, FeaturedInteractionHandler.directListenerOptions);
        });
        this.tag.addEventListener('mouseleave', this.onMouseLeave);
        this.tag.addEventListener('mouseenter', this.onMouseEnter);
    }

    public setDpadMode(enabled: boolean): void {
        this._dpadMode = enabled;
    }

    public buildDpadScrollEvent(event: WheelEvent): ControlMessage[] {
        // Fire-then-debounce: fire immediately on first event, ignore the rest
        // of the hardware burst, reset after events stop for DPAD_SCROLL_DEBOUNCE_TIME
        if (this.dpadScrollCooldown) {
            // Still in cooldown — reset the timer (debounce) but don't fire
            clearTimeout(this.dpadScrollTimer);
            this.dpadScrollTimer = setTimeout(() => {
                this.dpadScrollCooldown = false;
            }, FeaturedInteractionHandler.DPAD_SCROLL_DEBOUNCE_TIME);
            return [];
        }

        // First event in burst — fire immediately, enter cooldown
        this.dpadScrollCooldown = true;
        this.dpadScrollTimer = setTimeout(() => {
            this.dpadScrollCooldown = false;
        }, FeaturedInteractionHandler.DPAD_SCROLL_DEBOUNCE_TIME);

        const messages: ControlMessage[] = [];
        // Shift+scroll → horizontal (DPAD_LEFT/RIGHT), normal scroll → vertical (DPAD_UP/DOWN)
        let vDir = 0;
        let hDir = 0;
        if (event.shiftKey) {
            hDir = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
        } else {
            vDir = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
        }
        if (event.deltaX !== 0 && !event.shiftKey) {
            hDir = event.deltaX > 0 ? -1 : event.deltaX < 0 ? 1 : 0;
        }
        if (vDir === -1) {
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_DOWN, 0, 0));
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_DOWN, 0, 0));
        } else if (vDir === 1) {
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_UP, 0, 0));
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_UP, 0, 0));
        }
        if (hDir === -1) {
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT, 0, 0));
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_RIGHT, 0, 0));
        } else if (hDir === 1) {
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, 0, 0));
            messages.push(new KeyCodeControlMessage(MotionEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_LEFT, 0, 0));
        }
        return messages;
    }

    public buildScrollEvent(event: WheelEvent, screenInfo: ScreenInfo): ScrollControlMessage[] {
        const messages: ScrollControlMessage[] = [];
        const touchOnClient = InteractionHandler.buildTouchOnClient(event, screenInfo);
        if (touchOnClient) {
            const hScroll = event.deltaX > 0 ? -1 : event.deltaX < 0 ? 1 : 0;
            const vScroll = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
            const time = Date.now();
            if (
                !this.lastScrollEvent ||
                time - this.lastScrollEvent.time > FeaturedInteractionHandler.SCROLL_EVENT_THROTTLING_TIME ||
                this.lastScrollEvent.vScroll !== vScroll ||
                this.lastScrollEvent.hScroll !== hScroll
            ) {
                this.lastScrollEvent = { time, hScroll, vScroll };
                messages.push(new ScrollControlMessage(touchOnClient.touch.position, hScroll, vScroll, 0));
            }
        }
        return messages;
    }

    // Mouse button → Android keycode mapping (matches scrcpy desktop client defaults)
    private static readonly BUTTON_KEYCODE_MAP: Record<number, number> = {
        2: KeyEvent.KEYCODE_BACK, // right-click → BACK
        1: KeyEvent.KEYCODE_HOME, // middle-click → HOME
    };

    protected onInteraction(event: MouseEvent | TouchEvent | PointerEvent): void {
        if (this.handledEvents.has(event)) return;
        this.handledEvents.add(event);
        const screenInfo = this.player.getScreenInfo();
        if (!screenInfo) {
            return;
        }
        let messages: ControlMessage[];
        let storage: Map<number, TouchControlMessage>;
        if (window['PointerEvent'] && event instanceof PointerEvent) {
            storage = event.pointerType === 'mouse' ? this.storedFromMouseEvent : this.storedFromPointerEvent;
            const continuingGesture = event.type !== 'pointerdown' && storage.size > 0;
            if (event.target !== this.tag && !continuingGesture) {
                return;
            }
            // WKWebView may retarget pointermove/pointerup to body even after a
            // canvas pointerdown. Keep the gesture bound to the touch canvas so
            // coordinate mapping and MOVE/UP delivery remain continuous.
            const touchEvent = event.target === this.tag ? event : {
                clientX: event.clientX,
                clientY: event.clientY,
                type: event.type,
                target: this.tag,
                button: event.button,
                buttons: event.buttons,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
            };
            if (event.pointerType === 'mouse') {
                this.lastPointerMouseEvent = Date.now();
                const keycode = FeaturedInteractionHandler.BUTTON_KEYCODE_MAP[event.button];
                if (keycode !== undefined && (event.type === 'pointerdown' || event.type === 'pointerup')) {
                    const action = event.type === 'pointerdown' ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_UP;
                    this.listener.sendMessage(new KeyCodeControlMessage(action, keycode, 0, 0));
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                if (
                    this._dpadMode &&
                    event.button === 0 &&
                    (event.type === 'pointerdown' || event.type === 'pointerup')
                ) {
                    const action = event.type === 'pointerdown' ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_UP;
                    this.listener.sendMessage(new KeyCodeControlMessage(action, KeyEvent.KEYCODE_DPAD_CENTER, 0, 0));
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                messages = this.buildTouchEvent(touchEvent, screenInfo, storage);
                if (this.over) this.lastPosition = event;
            } else {
                this.lastPointerTouchEvent = Date.now();
                messages = this.buildTouchEvent(touchEvent, screenInfo, storage);
            }
            try {
                if (event.isTrusted && event.type === 'pointerdown') {
                    this.tag.setPointerCapture?.(event.pointerId);
                }
                if (event.isTrusted && (event.type === 'pointerup' || event.type === 'pointercancel')) {
                    if (this.tag.hasPointerCapture?.(event.pointerId)) {
                        this.tag.releasePointerCapture(event.pointerId);
                    }
                }
            } catch {
                // Global body listeners below remain the WebKit fallback.
            }
        } else if (event instanceof MouseEvent) {
            const continuingGesture = event.type !== 'mousedown' && this.storedFromMouseEvent.size > 0;
            if (event.target !== this.tag && !continuingGesture) {
                return;
            }
            if (!(window['WheelEvent'] && event instanceof WheelEvent) && Date.now() - this.lastPointerMouseEvent < 80) {
                return;
            }
            // Right-click → back, middle-click → home (always, both modes)
            const keycode = FeaturedInteractionHandler.BUTTON_KEYCODE_MAP[event.button];
            if (keycode !== undefined && (event.type === 'mousedown' || event.type === 'mouseup')) {
                const action = event.type === 'mousedown' ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_UP;
                this.listener.sendMessage(new KeyCodeControlMessage(action, keycode, 0, 0));
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (window['WheelEvent'] && event instanceof WheelEvent) {
                if (this._dpadMode) {
                    messages = this.buildDpadScrollEvent(event);
                } else {
                    messages = this.buildScrollEvent(event, screenInfo);
                }
            } else if (
                this._dpadMode &&
                event.button === 0 &&
                (event.type === 'mousedown' || event.type === 'mouseup')
            ) {
                // D-pad mode: left-click → DPAD_CENTER
                const action = event.type === 'mousedown' ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_UP;
                this.listener.sendMessage(new KeyCodeControlMessage(action, KeyEvent.KEYCODE_DPAD_CENTER, 0, 0));
                event.preventDefault();
                event.stopPropagation();
                return;
            } else {
                storage = this.storedFromMouseEvent;
                const touchEvent = event.target === this.tag ? event : {
                    clientX: event.clientX,
                    clientY: event.clientY,
                    type: event.type,
                    target: this.tag,
                    button: event.button,
                    buttons: event.buttons,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                };
                messages = this.buildTouchEvent(touchEvent, screenInfo, storage);
            }
            if (this.over) {
                this.lastPosition = event;
            }
        } else if (window['TouchEvent'] && event instanceof TouchEvent) {
            // Some mobile WebViews expose PointerEvent but only deliver TouchEvent.
            // Ignore TouchEvent only when a real touch/pen pointer event just arrived.
            if (Date.now() - this.lastPointerTouchEvent < 120) {
                return;
            }
            if (event.target !== this.tag) {
                return;
            }
            storage = this.storedFromTouchEvent;
            messages = this.formatTouchEvent(event, screenInfo, storage);
        } else {
            console.error(TAG, 'Unsupported event', event);
            return;
        }
        if (event.cancelable) {
            event.preventDefault();
        }
        event.stopPropagation();
        messages.forEach((message) => {
            this.listener.sendMessage(message);
        });
    }

    protected onKey(event: KeyboardEvent): void {
        if (!this.lastPosition) {
            return;
        }
        const { ctrlKey, shiftKey } = event;
        // The synthetic multi-touch gesture is gated on Ctrl/Shift; plain keys
        // and held-key repeats can't change it. Bail early to avoid rebuilding
        // a multi-touch event on every key (incl. auto-repeats). (#46)
        if (!shouldHandleMultiTouchKey({ repeat: event.repeat, ctrlKey, shiftKey })) {
            return;
        }
        const screenInfo = this.player.getScreenInfo();
        if (!screenInfo) {
            return;
        }
        const { target, button, buttons, clientY, clientX } = this.lastPosition;
        const type = InteractionHandler.SIMULATE_MULTI_TOUCH;
        const props = { ctrlKey, shiftKey, type, target, button, buttons, clientX, clientY };
        this.buildTouchEvent(props, screenInfo, new Map());
    }

    private onMouseEnter = (): void => {
        this.over = true;
    };

    private onDirectInteraction = (event: Event): void => {
        this.onInteraction(event as MouseEvent | TouchEvent | PointerEvent);
    };
    private onMouseLeave = (): void => {
        this.lastPosition = undefined;
        this.over = false;
        this.storedFromMouseEvent.forEach((message) => {
            this.listener.sendMessage(InteractionHandler.createEmulatedMessage(MotionEvent.ACTION_UP, message));
        });
        this.storedFromMouseEvent.clear();
        this.clearCanvas();
    };

    public override release(): void {
        super.release();
        FeaturedInteractionHandler.touchEventsNames.forEach((eventName) => {
            this.tag.removeEventListener(eventName, this.onDirectInteraction, FeaturedInteractionHandler.directListenerOptions);
        });
        this.tag.removeEventListener('mouseleave', this.onMouseLeave);
        this.tag.removeEventListener('mouseenter', this.onMouseEnter);
        this.storedFromMouseEvent.clear();
        this.storedFromPointerEvent.clear();
    }
}
