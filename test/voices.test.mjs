import test from "node:test";
import assert from "node:assert/strict";
import { OfflineAudioContext } from "node-web-audio-api";
import { BlipEngine, VOICES } from "../extensions/pi-blips/engine.ts";

const SR = 48_000;
const VOICE_ORDER = ["text", "thinking", "toolarg", "toolcall", "toolresult", "turnend", "error"];

// Regression guard for the bug that made this extension inaudible: blips at
// 0.05 peak (-26 dBFS) cannot be heard over media on a sink below ~50% volume.
test("voice peaks stay in the audible range and below clipping", () => {
	for (const voice of VOICE_ORDER) {
		const { gain } = VOICES[voice];
		assert.ok(gain >= 0.1, `${voice} at ${gain} is too quiet to hear over media`);
		assert.ok(gain <= 0.6, `${voice} at ${gain} risks clipping the mix bus`);
	}
});

test("/blips test fires one blip per voice, in a fixed order", async () => {
	const ctx = new OfflineAudioContext(1, SR * 4, SR);
	const engine = new BlipEngine(ctx, { mode: "discrete", master: 1 });
	const fired = [];
	engine.onEvent = (event) => fired.push(event.kind);

	const seconds = engine.test(0.1);
	// 7 voices, 0.4 s apart.
	assert.ok(Math.abs(seconds - 2.8) < 1e-9, `expected 2.8s, got ${seconds}`);
	await ctx.startRendering();
	assert.deepEqual(fired, VOICE_ORDER);
});

test("every blip fades in instead of starting at full level", async () => {
	const ctx = new OfflineAudioContext(1, SR * 4, SR);
	const engine = new BlipEngine(ctx, { mode: "discrete", master: 1 });
	const onsets = [];
	engine.onEvent = (event) => onsets.push({ kind: event.kind, at: event.at });
	engine.test(0.1);
	const data = (await ctx.startRendering()).getChannelData(0);

	// 1 ms after the onset, the 6 ms attack has only reached a fraction of peak.
	const window = Math.round(0.001 * SR);
	for (const { kind, at } of onsets) {
		const first = Math.round(at * SR);
		let early = 0;
		for (let i = first; i < first + window; i++) early = Math.max(early, Math.abs(data[i]));
		assert.ok(early < VOICES[kind].gain * 0.4, `${kind} jumps to ${early.toFixed(3)} within 1 ms`);
	}
});

// Square and sawtooth edges are the timbre, so the smoothness check applies to
// the continuous voices only; this is where an envelope bug would show up.
test("continuous voices never step", async () => {
	const ctx = new OfflineAudioContext(1, SR, SR);
	const engine = new BlipEngine(ctx, { mode: "discrete", master: 1 });
	for (const voice of ["text", "thinking", "turnend"]) engine.note(voice, 1, 0.02);
	const data = (await ctx.startRendering()).getChannelData(0);

	let maxStep = 0;
	for (let i = 1; i < data.length; i++) maxStep = Math.max(maxStep, Math.abs(data[i] - data[i - 1]));
	assert.ok(maxStep < 0.25, `sample step ${maxStep.toFixed(3)} would click`);
});
