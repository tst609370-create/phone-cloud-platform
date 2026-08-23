// src/app/googDevice/UhidManager.ts
import type { ControlMessage } from '../controlMessage/ControlMessage';
import { UhidCreateMessage } from '../controlMessage/UhidCreateMessage';
import { UhidDestroyMessage } from '../controlMessage/UhidDestroyMessage';
import { UhidInputMessage } from '../controlMessage/UhidInputMessage';

export const UHID_KEYBOARD_ID = 1;
export const UHID_MOUSE_ID = 2;

export class UhidManager {
    private active = false;

    constructor(private readonly sendMessage: (msg: ControlMessage) => void) {}

    start(): void {
        if (this.active) return;
        this.active = true;
        this.sendMessage(UhidCreateMessage.createKeyboard(UHID_KEYBOARD_ID));
        this.sendMessage(UhidCreateMessage.createMouse(UHID_MOUSE_ID));
    }

    stop(): void {
        if (!this.active) return;
        this.active = false;
        this.sendMessage(new UhidDestroyMessage(UHID_KEYBOARD_ID));
        this.sendMessage(new UhidDestroyMessage(UHID_MOUSE_ID));
    }

    sendKeyReport(modifier: number, keycodes: number[]): void {
        if (!this.active) return;
        this.sendMessage(UhidInputMessage.createKeyboardReport(UHID_KEYBOARD_ID, modifier, keycodes));
    }

    sendMouseReport(buttons: number, dx: number, dy: number, wheel: number): void {
        if (!this.active) return;
        this.sendMessage(UhidInputMessage.createMouseReport(UHID_MOUSE_ID, buttons, dx, dy, wheel));
    }
}
