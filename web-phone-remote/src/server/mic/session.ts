import type { MicRouteName, MicStatus } from '../../common/micProtocol';
import { MIC_PCM_RATE } from '../../common/micProtocol';
import { Logger } from '../Logger';
import type { OpenedMic } from './deviceBridge';
import { bytesToS16le, PcmResampler } from './resample';
import type { MicProbeFacts, MicRoutePlan } from './route';
import { selectMicRoute } from './route';

const log = Logger.for('MicSession');
const QUEUE_SAMPLES = MIC_PCM_RATE;

export interface MicTalkDeps {
    probe(): Promise<MicProbeFacts>;
    open(route: MicRouteName): Promise<OpenedMic>;
    onStatus(status: MicStatus): void;
}

/**
 * One browser socket's injection session. The chosen route stays open until
 * the socket closes so press-to-talk does not re-register audio policy on
 * every press. A failed route is dropped and the next candidate is tried.
 */
export class MicTalkSession {
    private facts: MicProbeFacts | undefined;
    private order: MicRouteName[] = [];
    private opened: OpenedMic | undefined;
    private opening: Promise<void> | undefined;
    private resampler = new PcmResampler(MIC_PCM_RATE, MIC_PCM_RATE);
    private pending: Int16Array[] = [];
    private pendingSamples = 0;
    private wantActive = false;
    private closed = false;
    private baseReason = '正在检测麦克风…';
    private note = '';
    private degraded = '';

    constructor(
        private readonly serial: string,
        private readonly deps: MicTalkDeps,
    ) {}

    async announce(): Promise<void> {
        try {
            this.facts = await this.deps.probe();
            const plan: MicRoutePlan = selectMicRoute(this.facts);
            this.order = plan.routes.slice();
            this.baseReason = plan.reason;
            this.note = '';
            this.degraded = '';
        } catch (err) {
            this.facts = {
                sdkInt: 0,
                rooted: false,
                bridgeInstalled: false,
                shellDexPresent: false,
                shellVerified: 'unknown',
            };
            this.order = [];
            this.baseReason = '麦克风能力探测失败';
            this.note = err instanceof Error ? err.message : '';
            log.warn(`probe failed for ${this.serial}: ${this.note}`);
        }
        if (!this.closed) this.emit();
    }

    setInputRate(rate: number): void {
        this.resampler.setInputRate(rate);
    }

    async begin(): Promise<void> {
        if (this.closed) return;
        this.wantActive = true;
        if (!this.facts) await this.announce();
        if (this.closed) return;
        await this.ensureOpen();
        if (!this.opened) {
            this.emit();
            return;
        }
        await this.opened.setActive(this.wantActive);
        if (this.wantActive) {
            try {
                await this.flush();
            } catch (err) {
                await this.failOver(err);
            }
        }
        this.emit();
    }

    async end(): Promise<void> {
        this.wantActive = false;
        this.pending = [];
        this.pendingSamples = 0;
        if (this.opened) {
            await this.opened.setActive(false).catch((err) => {
                log.warn(`mute failed for ${this.serial}: ${err instanceof Error ? err.message : err}`);
            });
        }
        if (!this.closed) this.emit();
    }

    async write(bytes: Uint8Array): Promise<void> {
        if (this.closed || !this.wantActive || bytes.byteLength < 2) return;
        const samples = this.resampler.process(bytesToS16le(bytes));
        if (samples.length === 0) return;
        if (!this.opened) {
            this.enqueue(samples);
            return;
        }
        try {
            await this.opened.writePcm(samples);
        } catch (err) {
            await this.failOver(err);
        }
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.wantActive = false;
        this.pending = [];
        this.pendingSamples = 0;
        const opened = this.opened;
        this.opened = undefined;
        this.order = [];
        if (opened) await opened.close().catch(() => undefined);
    }

    private enqueue(samples: Int16Array): void {
        this.pending.push(samples);
        this.pendingSamples += samples.length;
        while (this.pendingSamples > QUEUE_SAMPLES && this.pending.length > 1) {
            const dropped = this.pending.shift();
            this.pendingSamples -= dropped?.length ?? 0;
        }
    }

    private async flush(): Promise<void> {
        const queued = this.pending;
        this.pending = [];
        this.pendingSamples = 0;
        for (const chunk of queued) {
            if (!this.opened || !this.wantActive) return;
            await this.opened.writePcm(chunk);
        }
    }

    private async ensureOpen(): Promise<void> {
        if (this.opened) return;
        if (this.opening) {
            await this.opening;
            return;
        }
        const run = (async () => {
            while (!this.opened && this.order.length > 0 && !this.closed) {
                const route = this.order[0];
                if (!route) return;
                try {
                    const opened = await this.deps.open(route);
                    if (this.closed) {
                        await opened.close().catch(() => undefined);
                        return;
                    }
                    this.opened = opened;
                    this.note = '';
                    log.info(`mic route ${route} open for ${this.serial}`);
                    return;
                } catch (err) {
                    this.order.shift();
                    this.degraded = `${route} 不可用：${err instanceof Error ? err.message : String(err)}`;
                    this.note = this.degraded;
                    log.warn(this.note);
                }
            }
        })();
        this.opening = run.finally(() => {
            this.opening = undefined;
        });
        await this.opening;
    }

    private detach(): OpenedMic | undefined {
        const opened = this.opened;
        this.opened = undefined;
        return opened;
    }

    private async failOver(err: unknown): Promise<void> {
        const opened = this.detach();
        const failed = opened?.route;
        if (opened) await opened.close().catch(() => undefined);
        if (failed) this.order = this.order.filter((route) => route !== failed);
        this.degraded = `${failed ?? '注入'}中断：${err instanceof Error ? err.message : String(err)}`;
        this.note = this.degraded;
        log.warn(`mic failover for ${this.serial}: ${this.note}`);
        if (this.wantActive && !this.closed) {
            await this.ensureOpen();
            await this.opened?.setActive(true).catch(() => undefined);
        }
        if (!this.closed) this.emit();
    }

    private reasonText(): string {
        if (!this.opened && this.note) return this.note;
        if (this.opened && this.degraded) {
            return `${this.baseReason}（${this.degraded}，已改用 ${this.opened.route}）`;
        }
        return this.baseReason;
    }

    private emit(): void {
        const facts = this.facts;
        const supported = !!this.opened || this.order.length > 0;
        const status: MicStatus = {
            type: 'status',
            supported,
            route: this.opened?.route ?? this.order[0] ?? 'none',
            routes: this.opened
                ? [this.opened.route, ...this.order.filter((route) => route !== this.opened?.route)]
                : this.order.slice(),
            reason: this.reasonText(),
            active: !!this.opened && this.wantActive,
            rooted: facts?.rooted ?? false,
            bridgeInstalled: facts?.bridgeInstalled ?? false,
            sdkInt: facts?.sdkInt ?? 0,
        };
        this.deps.onStatus(status);
    }
}
