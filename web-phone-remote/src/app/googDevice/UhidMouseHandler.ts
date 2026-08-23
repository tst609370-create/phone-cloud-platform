// src/app/googDevice/UhidMouseHandler.ts
import type { UhidManager } from './UhidManager';

export class UhidMouseHandler {
    private buttonState = 0;
    private readonly canvas: HTMLElement;

    constructor(
        private readonly manager: UhidManager,
        canvas: HTMLElement,
    ) {
        this.canvas = canvas;
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onWheel = this.onWheel.bind(this);
        this.onPointerLockChange = this.onPointerLockChange.bind(this);
    }

    attach(): void {
        this.canvas.addEventListener('click', this.requestPointerLock);
        document.addEventListener('pointerlockchange', this.onPointerLockChange);
    }

    detach(): void {
        this.canvas.removeEventListener('click', this.requestPointerLock);
        document.removeEventListener('pointerlockchange', this.onPointerLockChange);
        this.removeMouseListeners();
        if (document.pointerLockElement === this.canvas) {
            document.exitPointerLock();
        }
        this.buttonState = 0;
    }

    private requestPointerLock = (): void => {
        this.canvas.requestPointerLock();
    };

    private onPointerLockChange(): void {
        if (document.pointerLockElement === this.canvas) {
            this.addMouseListeners();
        } else {
            this.removeMouseListeners();
            // Release all buttons
            if (this.buttonState !== 0) {
                this.buttonState = 0;
                this.manager.sendMouseReport(0, 0, 0, 0);
            }
        }
    }

    private addMouseListeners(): void {
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('mouseup', this.onMouseUp);
        document.addEventListener('wheel', this.onWheel);
    }

    private removeMouseListeners(): void {
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('mousedown', this.onMouseDown);
        document.removeEventListener('mouseup', this.onMouseUp);
        document.removeEventListener('wheel', this.onWheel);
    }

    private onMouseMove(event: MouseEvent): void {
        const dx = Math.max(-127, Math.min(127, event.movementX));
        const dy = Math.max(-127, Math.min(127, event.movementY));
        if (dx !== 0 || dy !== 0) {
            this.manager.sendMouseReport(this.buttonState, dx, dy, 0);
        }
    }

    private onMouseDown(event: MouseEvent): void {
        this.buttonState |= 1 << event.button;
        this.manager.sendMouseReport(this.buttonState, 0, 0, 0);
    }

    private onMouseUp(event: MouseEvent): void {
        this.buttonState &= ~(1 << event.button);
        this.manager.sendMouseReport(this.buttonState, 0, 0, 0);
    }

    private onWheel(event: WheelEvent): void {
        event.preventDefault();
        const wheel = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
        if (wheel !== 0) {
            this.manager.sendMouseReport(this.buttonState, 0, 0, wheel);
        }
    }
}
