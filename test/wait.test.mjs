import test from "node:test";
import assert from "node:assert/strict";
import { OfflineAudioContext } from "node-web-audio-api";
import { BlipEngine, VOICES, WAIT_VOICE } from "../extensions/pi-blips/engine.ts";
import { loudestFrequency, peak, SR } from "./audio-helpers.mjs";

const silent = (seconds = 6) => new OfflineAudioContext(1, SR * seconds, SR);

test("nothing beats while the agent is not blocked", () => {
	const engine = new BlipEngine(silent(), { mode: "discrete" });
	const fired = [];
	engine.onEvent = (event) => fired.push(event);

	assert.equal(engine.waitState(), null);
	for (let t = 0; t < 5; t++) engine.beat(t);
	assert.deepEqual(fired, [], "an idle clock must be silent");
});

test("entering a wait state beats at once, redundant transitions do not", () => {
	const engine = new BlipEngine(silent(), { mode: "discrete" });
	const fired = [];
	engine.onEvent = (event) => fired.push([event.kind, event.at]);

	engine.wait("model", 1);
	assert.deepEqual(fired, [["waitmodel", 1]], "the state change must be audible immediately");

	// turn_start and agent_start both fire for the same wait.
	engine.wait("model", 1.01);
	assert.equal(fired.length, 1, "a redundant transition must not re-beat");

	engine.wait(null, 1.02);
	assert.equal(engine.waitState(), null);
	engine.beat(1.03);
	assert.equal(fired.length, 1, "leaving the wait state stops the heartbeat");
});

test("the two personalities use different voices, and switch instantly", () => {
	const engine = new BlipEngine(silent(), { mode: "discrete" });
	const fired = [];
	engine.onEvent = (event) => fired.push([event.kind, event.at]);

	assert.notEqual(WAIT_VOICE.model, WAIT_VOICE.tool);
	assert.notEqual(VOICES.waitmodel.wave, VOICES.waittool.wave, "the personalities must not sound alike");

	// A 3 s model wait, then a tool that returns instantly.
	engine.wait("model", 0);
	for (let t = 1; t <= 3; t++) engine.beat(t);
	engine.wait("tool", 3.05);
	engine.wait("model", 3.1);

	const kinds = fired.map(([kind]) => kind);
	assert.deepEqual(kinds, ["waitmodel", "waitmodel", "waitmodel", "waitmodel", "waittool"]);
	// The switch to "tool" sounds 50 ms after the last model beat: a different
	// voice owns its own floor, so it is not swallowed.
	assert.equal(fired.at(-1)[1], 3.05);
});

test("a tool that returns instantly cannot re-beat over the model's pulse", () => {
	const engine = new BlipEngine(silent(), { mode: "discrete" });
	const fired = [];
	engine.onEvent = (event) => fired.push([event.kind, event.at]);

	engine.wait("model", 0);
	engine.wait("tool", 0.1); // tool started
	engine.wait("model", 0.2); // tool finished before a whole beat elapsed
	const modelBeats = fired.filter(([kind]) => kind === "waitmodel");
	assert.equal(modelBeats.length, 1, "flapping between states must not double the pulse");
});

test("beats alternate high and low, one per second", async () => {
	const ctx = silent();
	const engine = new BlipEngine(ctx, { mode: "discrete", master: 1 });
	engine.wait("model", 0.1);
	for (let t = 1.1; t <= 3.1; t += 1) engine.beat(t);
	const data = (await ctx.startRendering()).getChannelData(0);

	const pitches = [0.1, 1.1, 2.1, 3.1].map((at) => loudestFrequency(data, at, at + VOICES.waitmodel.dur + 0.02));
	assert.equal(pitches[0], VOICES.waitmodel.freq, `first beat should be ${VOICES.waitmodel.freq} Hz, got ${pitches[0]}`);
	assert.equal(pitches[1], VOICES.waitmodel.alt, `second beat should be ${VOICES.waitmodel.alt} Hz, got ${pitches[1]}`);
	assert.equal(pitches[2], pitches[0], "the pattern must repeat, not walk");
	assert.equal(pitches[3], pitches[1]);

	// One second apart, and quiet enough not to fight the stream blips.
	const onsets = [0.1, 1.1, 2.1, 3.1];
	for (let i = 1; i < onsets.length; i++) assert.equal(onsets[i] - onsets[i - 1], 1);
	assert.ok(peak(data) < VOICES.text.gain, "the heartbeat sits under the streaming blips");
});

test("beats are rate limited so state flapping cannot machine-gun", () => {
	const engine = new BlipEngine(silent(), { mode: "discrete" });
	let count = 0;
	engine.onEvent = () => count++;

	engine.wait("model", 0);
	for (let t = 0.05; t < 0.5; t += 0.05) engine.beat(t);
	assert.equal(count, 1, "the 0.5 s floor must absorb rapid beats");
});
