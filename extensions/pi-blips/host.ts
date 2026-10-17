/**
 * Owns the audio worker so no audio call ever runs on pi's main thread.
 *
 * `node-web-audio-api` enqueues every graph mutation onto a bounded 256-slot
 * channel whose only drainer is the audio device callback. When the device
 * stops calling back, the queue fills and the next blip blocks its caller
 * inside `send()` with no deadline (elecnix/pi-blips#2). On pi's main thread
 * that call would freeze the agent loop and the TUI forever, so the context and
 * engine live in a worker instead: the worker may wedge, the session cannot.
 *
 * A watchdog probes the worker. A worker stuck in a native call stops running
 * its event loop, so it stops answering pings; the host then terminates it and
 * starts a fresh one. That is what lets audio recover once the device comes
 * back, instead of staying silent until the session is restarted.
 */
import type { Mode, Voice, WaitPersonality } from "./engine.ts";

/** The slice of `node:worker_threads`'s Worker this host needs, so tests can fake it. */
export interface AudioWorker {
	postMessage(message: unknown): void;
	terminate(): unknown;
	on(event: "message", listener: (message: unknown) => void): unknown;
	unref?(): void;
}

export type WorkerFactory = () => AudioWorker;

export interface BlipHostOptions {
	createWorker: WorkerFactory;
	mode: Mode;
	master: number;
	/** Period between liveness probes. */
	pingIntervalMs?: number;
	/** A worker silent for longer than this is considered wedged. */
	pongTimeoutMs?: number;
	/** Stop replacing after this many consecutive wedges. */
	maxRestarts?: number;
	/** Called once when the host gives up on audio, or when the worker reports a dead device. */
	onFatal?: (error: unknown) => void;
	/** Injectable clock and timers so the watchdog is testable without real time. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	now?: () => number;
	/** Passed to the worker so it can log every fired voice to a file. */
	log?: string;
}

export class BlipHost {
	private readonly createWorker: WorkerFactory;
	private readonly onFatal: ((error: unknown) => void) | undefined;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly now: () => number;
	private readonly pingIntervalMs: number;
	private readonly pongTimeoutMs: number;
	private readonly maxRestarts: number;
	private readonly log: string | undefined;

	private mode: Mode;
	private master: number;
	private worker: AudioWorker | undefined;
	private timer: unknown;
	private pingId = 0;
	private lastPongAt = 0;
	private restarts = 0;
	private stopped = false;
	private fatal = false;

	constructor(options: BlipHostOptions) {
		this.createWorker = options.createWorker;
		this.onFatal = options.onFatal;
		this.setTimer = options.setTimer ?? ((fn, ms) => setInterval(fn, ms));
		this.clearTimer = options.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
		this.now = options.now ?? (() => Date.now());
		this.pingIntervalMs = options.pingIntervalMs ?? 5_000;
		this.pongTimeoutMs = options.pongTimeoutMs ?? 15_000;
		this.maxRestarts = options.maxRestarts ?? 5;
		this.mode = options.mode;
		this.master = options.master;
		this.log = options.log;
	}

	start(): void {
		if (this.stopped || this.worker) return;
		this.spawn();
	}

	/** True while audio is expected to work. */
	alive(): boolean {
		return !this.stopped && !this.fatal && this.worker !== undefined;
	}

	/** How many times a wedged worker has been replaced (for `/blips status`). */
	restartsSoFar(): number {
		return this.restarts;
	}

	note(voice: Voice): void {
		this.send({ type: "note", voice });
	}

	wait(kind: WaitPersonality | null): void {
		this.send({ type: "wait", kind });
	}

	beat(): void {
		this.send({ type: "beat" });
	}

	setMode(mode: Mode): void {
		this.mode = mode;
		this.send({ type: "mode", mode });
	}

	setMaster(master: number): void {
		this.master = master;
		this.send({ type: "master", master });
	}

	test(): void {
		this.send({ type: "test" });
	}

	close(): void {
		this.stopped = true;
		this.stopTimer();
		const doomed = this.worker;
		this.worker = undefined;
		if (doomed) void Promise.resolve(doomed.terminate()).catch(() => {});
	}

	private spawn(): void {
		const worker = this.createWorker();
		this.worker = worker;
		this.lastPongAt = this.now();
		worker.on("message", (message) => this.onMessage(message));
		worker.unref?.();
		worker.postMessage({ type: "init", mode: this.mode, master: this.master, ...(this.log !== undefined ? { log: this.log } : {}) });
		this.timer = this.setTimer(() => this.probe(), this.pingIntervalMs);
	}

	private probe(): void {
		if (this.stopped || !this.worker) return;
		this.worker.postMessage({ type: "ping", id: ++this.pingId });
		if (this.now() - this.lastPongAt > this.pongTimeoutMs) {
			this.replace();
		}
	}

	private onMessage(message: unknown): void {
		const typed = message as { type?: string; error?: string };
		if (typed.type === "pong" || typed.type === "ready") {
			this.lastPongAt = this.now();
			return;
		}
		// A dead device is not a wedge: the worker is still answering, so we take it
		// at its word and stop rather than restart into the same failure.
		if (typed.type === "dead") {
			this.stopTimer();
			this.fatal = true;
			this.onFatal?.(new Error(typed.error ?? "audio worker reported a dead device"));
		}
	}

	/** Terminate a wedged worker and start a fresh context, up to the restart cap. */
	private replace(): void {
		const doomed = this.worker;
		this.worker = undefined;
		if (doomed) void Promise.resolve(doomed.terminate()).catch(() => {});
		if (this.stopped) return;

		this.restarts += 1;
		if (this.restarts > this.maxRestarts) {
			this.stopTimer();
			this.fatal = true;
			this.onFatal?.(new Error(`audio disabled after ${this.maxRestarts} wedged workers`));
			return;
		}
		this.spawn();
	}

	/**
	 * A message for the worker, unless it has already gone quiet. Dropping while
	 * the worker is wedged keeps its inbox from growing without bound during the
	 * window between the stall and the watchdog noticing it.
	 */
	private send(message: unknown): void {
		if (!this.alive()) return;
		if (this.now() - this.lastPongAt > this.pongTimeoutMs) return;
		this.worker!.postMessage(message);
	}

	private stopTimer(): void {
		if (this.timer === undefined) return;
		this.clearTimer(this.timer);
		this.timer = undefined;
	}
}
