import test from "node:test";
import assert from "node:assert/strict";
import { OfflineAudioContext } from "node-web-audio-api";
import { BlipEngine, VOICES } from "../extensions/pi-blips/engine.ts";

const silent = () => new OfflineAudioContext(1, 48_000, 48_000);

test("discrete mode throttles a 100 token/s stream to the voice floor", () => {
	const engine = new BlipEngine(silent(), { mode: "discrete" });
	const fired = [];
	engine.onEvent = (event) => fired.push(event);

	// 60 deltas at 10 ms spacing: the measured shape of a real stream.
	const deltas = 60;
	const spacing = 0.01;
	for (let i = 0; i < deltas; i++) engine.note("text", 1, i * spacing);

	assert.ok(fired.length > 0, "some blips must survive");
	assert.ok(fired.length < deltas / 2, `expected heavy throttling, fired ${fired.length}/${deltas}`);

	const floor = VOICES.text.minGap;
	for (let i = 1; i < fired.length; i++) {
		const gap = fired[i].at - fired[i - 1].at;
		assert.ok(gap >= floor - 1e-6, `blips ${gap.toFixed(4)}s apart, floor is ${floor}s`);
	}
	assert.equal(engine.stats().dropped, deltas - fired.length);
});

test("structural voices are never rate limited", () => {
	const engine = new BlipEngine(silent(), { mode: "discrete" });
	const fired = [];
	engine.onEvent = (event) => fired.push(event.kind);

	// A tool call and its result can land microseconds apart and both matter.
	engine.note("toolcall", 1, 0);
	engine.note("toolresult", 1, 0.001);
	engine.note("turnend", 1, 0.001);
	assert.deepEqual(fired, ["toolcall", "toolresult", "turnend"]);
	assert.equal(engine.stats().dropped, 0);
});

test("per-voice floors differ, so thinking does not drown out output", () => {
	assert.ok(VOICES.thinking.minGap > VOICES.text.minGap, "thinking needs the wider floor");
	assert.equal(VOICES.error.minGap, undefined, "errors must never be dropped");
	assert.equal(VOICES.turnend.minGap, undefined);
});
