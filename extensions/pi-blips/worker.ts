/**
 * Audio worker entry point.
 *
 * Owns the `AudioContext`, the blip engine, and the density clock, so every
 * call into `node-web-audio-api` happens off pi's main thread.
 *
 * This is the fix for the wedge described in elecnix/pi-blips#2. The addon
 * sends each graph mutation over a bounded 256-slot channel whose only drainer
 * is the audio device callback; when the device stops calling back, the queue
 * fills and the next blip blocks its caller inside `send()` with no deadline.
 * If that call ran on pi's main thread it would freeze the agent loop and the
 * TUI forever, so it runs here instead: this worker may wedge, the session
 * cannot. `host.ts` probes the worker and replaces it when it stops answering.
 */
import { appendFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { BlipEngine, type Mode, type Voice, type WaitPersonality } from "./engine.ts";

/** How often the density mode aggregates the stream, in milliseconds. */
const DENSITY_TICK_MS = 80;

export type WorkerCommand =
	| { type: "init"; mode: Mode; master: number; log?: string }
	| { type: "note"; voice: Voice }
	| { type: "wait"; kind: WaitPersonality | null }
	| { type: "beat" }
	| { type: "mode"; mode: Mode }
	| { type: "master"; master: number }
	| { type: "test" }
	| { type: "ping"; id: number }
	| { type: "close" };

export type WorkerMessage =
	| { type: "ready" }
	| { type: "pong"; id: number }
	| { type: "dead"; error: string };

/** The slice of a MessagePort this module needs, so it can be driven by a stub. */
export interface WorkerPort {
	postMessage(message: WorkerMessage): void;
	on(event: "message", listener: (message: WorkerCommand) => void): unknown;
}

export function runAudioWorker(port: WorkerPort): void {
	let engine: BlipEngine | undefined;
	let ctx: import("node-web-audio-api").AudioContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	function stopTicker() {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	}

	function startTicker() {
		stopTicker();
		if (!engine || engine.mode !== "density") return;
		ticker = setInterval(() => engine?.flush(), DENSITY_TICK_MS);
	}

	async function boot(command: Extract<WorkerCommand, { type: "init" }>) {
		stopTicker();
		// Lazy so a missing/broken audio backend cannot break extension loading.
		const { AudioContext } = await import("node-web-audio-api");
		ctx = new AudioContext();
		engine = new BlipEngine(ctx, {
			mode: command.mode,
			master: command.master,
			onEvent: command.log ? (event) => appendFileSync(command.log!, `${event.kind} ${event.at.toFixed(3)} ${event.weight ?? 1}\n`) : undefined,
			onError: (error) => port.postMessage({ type: "dead", error: String(error) }),
		});
		startTicker();
		port.postMessage({ type: "ready" });
	}

	port.on("message", (command) => {
		try {
			switch (command.type) {
				case "init":
					void boot(command).catch((error) => port.postMessage({ type: "dead", error: String(error) }));
					break;
				case "note":
					engine?.note(command.voice);
					break;
				case "wait":
					engine?.wait(command.kind);
					break;
				case "beat":
					engine?.beat();
					break;
				case "mode":
					if (engine) engine.mode = command.mode;
					startTicker();
					break;
				case "master":
					engine?.setMaster(command.master);
					break;
				case "test":
					engine?.test();
					break;
				// A wedged worker never reaches this arm: it is blocked inside
				// `engine.note()` and its event loop cannot run, so no pong is sent
				// and the host replaces it.
				case "ping":
					port.postMessage({ type: "pong", id: command.id });
					break;
				case "close":
					stopTicker();
					void ctx?.close();
					break;
			}
		} catch (error) {
			port.postMessage({ type: "dead", error: String(error) });
		}
	});
}

// Only wire the real parent port when actually running as a worker.
if (parentPort) runAudioWorker(parentPort as unknown as WorkerPort);
