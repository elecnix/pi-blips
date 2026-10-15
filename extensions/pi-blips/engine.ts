/**
 * Sonification engine for a token stream.
 *
 * Works on any BaseAudioContext (live device or OfflineAudioContext), so the
 * same code paths can be rendered to a file for testing.
 *
 * Every method here is synchronous. pi awaits `message_update` handlers in
 * stream order, so nothing in this file may await or spawn a process.
 */
import type { BaseAudioContext } from "node-web-audio-api";

export type Voice =
	| "text"
	| "thinking"
	| "toolarg"
	| "toolcall"
	| "toolresult"
	| "turnend"
	| "error"
	| "waitmodel"
	| "waittool";
export type Mode = "discrete" | "density";
/** What the agent is blocked on, which decides the heartbeat's personality. */
export type WaitPersonality = "model" | "tool";

/** The voice each wait personality beats with. */
export const WAIT_VOICE: Record<WaitPersonality, Voice> = { model: "waitmodel", tool: "waittool" };

interface VoiceSpec {
	wave: OscillatorType;
	freq: number;
	/** Pitch used on every second beat, for voices that alternate (the heartbeats). */
	alt?: number;
	/** Random detune range in Hz, so a stream of blips does not sound mechanical. */
	spread?: number;
	dur: number;
	gain: number;
	/** Multiply the frequency by this over the blip's duration. */
	glide?: number;
	/** Per-voice floor in seconds: events arriving faster than this are dropped. */
	minGap?: number;
	/** Overrides used when this voice is aggregated onto the density clock. */
	density?: { dur: number; gain: number };
}

// Peak amplitudes are set for a system output at everyday volume: roughly
// -10 dBFS, i.e. as loud as ordinary media content. Anything near 0.05 is
// inaudible unless the sink volume is near 100%.
export const VOICES: Record<Voice, VoiceSpec> = {
	text: { wave: "sine", freq: 740, spread: 70, dur: 0.05, gain: 0.3, minGap: 0.045, density: { dur: 0.16, gain: 0.25 } },
	thinking: { wave: "triangle", freq: 300, spread: 25, dur: 0.09, gain: 0.22, minGap: 0.07, density: { dur: 0.2, gain: 0.2 } },
	toolarg: { wave: "triangle", freq: 1250, spread: 400, dur: 0.02, gain: 0.12, minGap: 0.05, density: { dur: 0.09, gain: 0.14 } },
	toolcall: { wave: "square", freq: 500, dur: 0.09, gain: 0.3, glide: 1.6 },
	toolresult: { wave: "square", freq: 900, dur: 0.09, gain: 0.28, glide: 0.5 },
	turnend: { wave: "sine", freq: 1050, dur: 0.22, gain: 0.3, glide: 0.75 },
	error: { wave: "sawtooth", freq: 170, dur: 0.28, gain: 0.45 },
	// Waiting, at one beat per second, alternating high/low. Two personalities so
	// the two kinds of dead air are distinguishable with your eyes closed: a
	// patient falling triangle while the provider thinks, a bright rising square
	// while a tool runs. The 0.5 s floor absorbs state flapping (a tool that
	// returns instantly must not re-beat over the model's heartbeat).
	waitmodel: { wave: "triangle", freq: 520, alt: 390, dur: 0.08, gain: 0.16, minGap: 0.5 },
	waittool: { wave: "square", freq: 660, alt: 990, dur: 0.045, gain: 0.15, minGap: 0.5 },
};

/** Voices that stream too fast to be discrete and get aggregated in density mode. */
const STREAMING: Voice[] = ["text", "thinking", "toolarg"];

export interface BlipEvent {
	kind: string;
	at: number;
	weight?: number;
}

interface FireOptions {
	when?: number;
	gain?: number;
	detune?: number;
	/** Absolute frequency, used by the alternating heartbeats. Skips detune. */
	pitch?: number;
	density?: boolean;
	bypassGate?: boolean;
	weight?: number;
}

export interface EngineOptions {
	master?: number;
	mode?: Mode;
	onEvent?: (event: BlipEvent) => void;
	/** Called once when the audio backend fails, after which the engine goes quiet. */
	onError?: (error: unknown) => void;
}

export class BlipEngine {
	private readonly ctx: BaseAudioContext;
	private readonly out: GainNode;
	private readonly pending = new Map<Voice, number>();
	private readonly lastFire = new Map<Voice, number>();
	private readonly hits: number[] = [];
	private readonly fired: Record<string, number> = {};
	private suppressed = 0;
	/** Set when the audio backend throws, so a lost device cannot spam errors per delta. */
	private dead = false;
	/** Current wait state, or null when the agent is not blocked on anything. */
	private waiting: WaitPersonality | null = null;
	private beatParity = 0;
	mode: Mode;
	onEvent?: (event: BlipEvent) => void;
	onError?: (error: unknown) => void;

	constructor(ctx: BaseAudioContext, options: EngineOptions = {}) {
		this.ctx = ctx;
		this.mode = options.mode ?? "discrete";
		this.onEvent = options.onEvent;
		this.onError = options.onError;

		this.out = ctx.createGain();
		this.out.gain.value = options.master ?? 1;
		// Safety net for overlapping blips at 20/s; not a mix-bus compressor.
		const limiter = ctx.createDynamicsCompressor();
		limiter.threshold.value = -10;
		limiter.ratio.value = 8;
		limiter.attack.value = 0.003;
		limiter.release.value = 0.1;
		this.out.connect(limiter).connect(ctx.destination);
	}

	setMaster(value: number) {
		this.out.gain.value = Math.max(0, Math.min(4, value));
	}

	/**
	 * Record one stream event. In discrete mode it sounds immediately; in density
	 * mode it accumulates weight for the next flush(). `when` is the audio-clock
	 * time it happened, which callers only pass when rendering offline.
	 */
	note(voice: Voice, weight = 1, when?: number) {
		const spec = VOICES[voice];
		if (this.mode === "discrete" || !spec.density) {
			this.safeFire(voice, { when });
			return;
		}
		this.pending.set(voice, (this.pending.get(voice) ?? 0) + weight);
		this.count();
	}

	/**
	 * Called on the density clock. Emits at most one aggregated blip per active
	 * streaming voice; structural voices never queue here.
	 */
	flush(when?: number) {
		if (this.pending.size === 0) return;
		const entries = [...this.pending.entries()];
		this.pending.clear();
		const now = when ?? this.ctx.currentTime;
		for (const [voice, weight] of entries) {
			// A full tick is ~4 deltas at 50 tokens/s; louder and higher when denser.
			// The floor keeps a slow stream audible: density blips are longer and far
			// more frequent than discrete ones, so they sit below the discrete peak.
			const intensity = Math.min(1, weight / 4);
			const rate = weight / 0.08;
			const detune = 1 + Math.min(1, rate / 60) * 0.6;
			this.safeFire(voice, { when: now, gain: 0.5 + intensity * 0.5, detune, density: true, weight });
		}
	}

	/**
	 * The `/blips test` sequence: one of each streaming and structural voice, then
	 * the wait heartbeat at its real 1 Hz cadence, high and low per personality.
	 */
	test(now = this.ctx.currentTime + 0.1) {
		const order: Voice[] = ["text", "thinking", "toolarg", "toolcall", "toolresult", "turnend", "error"];
		order.forEach((voice, i) => this.safeFire(voice, { when: now + i * 0.4, bypassGate: true }));

		let at = now + order.length * 0.4 + 0.6;
		for (const kind of ["model", "tool"] as WaitPersonality[]) {
			for (let parity = 0; parity < 2; parity++) {
				this.fireBeat(kind, parity, at);
				at += 1;
			}
		}
		return at - now - 1;
	}

	/** Which wait state is currently heartbeating, if any. */
	waitState() {
		return this.waiting;
	}

	/**
	 * Enter or leave a wait state: "model" while the provider is being asked,
	 * "tool" while tools run. Each wait starts on the high pitch and beats
	 * immediately, so a change of state is audible without waiting for the clock.
	 */
	wait(kind: WaitPersonality | null, when?: number) {
		if (this.waiting === kind) return;
		this.waiting = kind;
		this.beatParity = 0;
		if (kind) this.fireBeat(kind, this.beatParity++, when);
	}

	/** One beat of the wait heartbeat; a no-op when nothing is pending. */
	beat(when?: number) {
		if (!this.waiting) return;
		this.fireBeat(this.waiting, this.beatParity++, when);
	}

	/** One beat, stepping between the spec's two pitches. */
	private fireBeat(kind: WaitPersonality, parity: number, when?: number) {
		const voice = WAIT_VOICE[kind];
		const spec = VOICES[voice];
		this.safeFire(voice, { when, pitch: parity % 2 === 1 ? (spec.alt ?? spec.freq) : spec.freq });
	}

	/** Blips per second over the last `window` seconds. */
	rate(window = 1) {
		const cut = this.ctx.currentTime - window;
		while (this.hits.length && this.hits[0] < cut) this.hits.shift();
		return this.hits.length / window;
	}

	stats() {
		return { fired: { ...this.fired }, dropped: this.suppressed, pending: this.pending.size, dead: this.dead };
	}

	/** True once the audio backend has failed; every later note is a no-op. */
	isDead() {
		return this.dead;
	}

	private count() {
		this.hits.push(this.ctx.currentTime);
	}

	private safeFire(voice: Voice, opts: FireOptions = {}) {
		if (this.dead) return;
		try {
			this.fire(voice, opts);
		} catch (error) {
			this.dead = true;
			this.onError?.(error);
		}
	}

	private fire(voice: Voice, opts: FireOptions = {}) {
		const spec = VOICES[voice];
		const now = opts.when ?? this.ctx.currentTime + 0.005;
		const gap = opts.bypassGate ? 0 : (spec.minGap ?? 0);
		const prev = this.lastFire.get(voice);
		if (gap > 0 && prev !== undefined && now - prev < gap) {
			this.suppressed++;
			return;
		}
		this.lastFire.set(voice, now);

		const shape = opts.density && spec.density ? spec.density : spec;
		const detune = opts.detune ?? 1;
		// The heartbeats step between two fixed pitches, so they skip the detune.
		const freq = opts.pitch ?? spec.freq * detune * (1 + ((Math.random() - 0.5) * (spec.spread ?? 0)) / spec.freq);

		const osc = this.ctx.createOscillator();
		osc.type = spec.wave;
		osc.frequency.setValueAtTime(freq, now);
		if (spec.glide) osc.frequency.exponentialRampToValueAtTime(freq * spec.glide, now + shape.dur);

		const env = this.ctx.createGain();
		const peak = shape.gain * (opts.gain ?? 1);
		env.gain.setValueAtTime(0, now);
		env.gain.linearRampToValueAtTime(peak, now + Math.min(0.006, shape.dur / 4));
		env.gain.exponentialRampToValueAtTime(0.0001, now + shape.dur);

		osc.connect(env).connect(this.out);
		osc.start(now);
		osc.stop(now + shape.dur + 0.02);

		this.fired[voice] = (this.fired[voice] ?? 0) + 1;
		this.count();
		this.onEvent?.({ kind: voice, at: now, weight: opts.weight });
	}
}
