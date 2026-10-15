/**
 * Decides which kind of dead air the agent is in, from pi's lifecycle events,
 * and owns the 1 Hz pulse.
 *
 * Pure by construction: it holds no audio, and its clock is injectable, so every
 * rule below — the parallel-tool tracking, the redundant transitions, and the
 * exact pulse schedule — is testable without an output device or real time.
 */
import type { WaitPersonality } from "./engine.ts";

export interface WaitSink {
	/** Start, or switch to, heartbeating this personality. */
	begin(kind: WaitPersonality): void;
	/** One pulse. */
	beat(): void;
	/** Stop heartbeating. */
	end(): void;
}

export interface WaitTrackerOptions {
	/** Milliseconds between pulses. */
	intervalMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface WaitTracker {
	/** Which personality is currently heartbeating, if any. */
	state(): WaitPersonality | null;
	agentStart(): void;
	turnStart(): void;
	/** Any streamed delta: the provider answered, so the wait is over. */
	delta(): void;
	toolStart(toolCallId: string): void;
	toolEnd(toolCallId: string): void;
	turnEnd(): void;
	agentEnd(): void;
	/** Force the heartbeat off, e.g. when the feature is disabled. */
	stop(): void;
}

const defaultSetTimer = (fn: () => void, ms: number) => setTimeout(fn, ms);
const defaultClearTimer = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>);

export function createWaitTracker(sink: WaitSink, enabled: () => boolean, options: WaitTrackerOptions = {}): WaitTracker {
	const intervalMs = options.intervalMs ?? 1000;
	const setTimer = options.setTimer ?? defaultSetTimer;
	const clearTimer = options.clearTimer ?? defaultClearTimer;

	/** Tool calls still running. pi runs them in parallel, so this is a set. */
	const running = new Set<string>();
	let state: WaitPersonality | null = null;
	let timer: unknown;

	function disarm() {
		if (timer === undefined) return;
		clearTimer(timer);
		timer = undefined;
	}

	/**
	 * Anchor the next pulse to now, rather than running a free clock from session
	 * start. A free clock lands wherever it happens to be when the state changes —
	 * measured once at 22 ms after the change beat — and that pulse is then gated
	 * away as too close, leaving an audible hole in the heartbeat.
	 */
	function arm() {
		disarm();
		timer = setTimer(() => {
			sink.beat();
			arm();
		}, intervalMs);
	}

	function begin(kind: WaitPersonality) {
		// Redundant transitions are free: agent_start and turn_start both fire for
		// the same wait, and a second call must not re-beat or re-arm.
		if (!enabled() || state === kind) return;
		state = kind;
		sink.begin(kind);
		arm();
	}

	function end() {
		if (state === null) return;
		state = null;
		running.clear();
		disarm();
		sink.end();
	}

	const backTo = () => (running.size > 0 ? "tool" : "model") as WaitPersonality;

	return {
		state: () => state,
		agentStart: () => begin("model"),
		turnStart: () => begin("model"),
		delta: () => end(),
		toolStart: (toolCallId: string) => {
			running.add(toolCallId);
			begin("tool");
		},
		toolEnd: (toolCallId: string) => {
			running.delete(toolCallId);
			// Only ever continue a wait that is already running: a tool ending when
			// nothing is pending (a cancel arriving after agent_end, say) must not
			// start a heartbeat that would then run until the next event.
			if (state !== null) begin(backTo());
		},
		turnEnd: () => {
			if (state !== null) begin(backTo());
		},
		agentEnd: () => end(),
		stop: () => end(),
	};
}
