import test from "node:test";
import assert from "node:assert/strict";
import { OfflineAudioContext } from "node-web-audio-api";
import { BlipEngine } from "../extensions/pi-blips/engine.ts";
import { loudestFrequency, rms, SR } from "./audio-helpers.mjs";

function renderRamp() {
	const seconds = 3;
	const tick = 0.08; // the density clock
	const ctx = new OfflineAudioContext(1, SR * seconds, SR);
	const engine = new BlipEngine(ctx, { mode: "density", master: 1 });

	const rateAt = (t) => 5 + (95 * t) / seconds; // 5 -> 100 tokens/s
	let ticks = 0;
	for (let t = tick; t < seconds; t += tick) {
		for (let i = 0; i < Math.round(rateAt(t) * tick); i++) engine.note("text", 1, t);
		engine.flush(t);
		ticks++;
	}
	return { ctx, engine, ticks, seconds };
}

test("density mode aggregates a tick into one blip instead of dropping it", () => {
	const { ctx, engine, ticks } = renderRamp();
	const blips = Object.values(engine.stats().fired).reduce((a, b) => a + b, 0);

	assert.ok(blips <= ticks, `at most one blip per tick, got ${blips} blips for ${ticks} ticks`);
	assert.ok(blips >= ticks - 2, `a busy stream should sound on nearly every tick, got ${blips}/${ticks}`);
});

test("density mode: louder and higher as throughput rises", async () => {
	const { ctx, seconds } = renderRamp();
	const data = (await ctx.startRendering()).getChannelData(0);

	const slow = rms(data, 0, 0.5);
	const fast = rms(data, seconds - 0.5, seconds);
	assert.ok(fast > slow * 1.5, `amplitude must track throughput: ${slow.toFixed(4)} -> ${fast.toFixed(4)}`);

	const slowHz = loudestFrequency(data, 0, 0.5);
	const fastHz = loudestFrequency(data, seconds - 0.5, seconds);
	assert.ok(fastHz > slowHz + 100, `pitch must track throughput: ${slowHz} Hz -> ${fastHz} Hz`);
});

test("an idle clock stays silent", async () => {
	const ctx = new OfflineAudioContext(1, SR, SR);
	const engine = new BlipEngine(ctx, { mode: "density" });
	for (let t = 0; t < 1; t += 0.08) engine.flush(t);
	const data = (await ctx.startRendering()).getChannelData(0);
	assert.ok(data.every((s) => s === 0), "no deltas, no sound");
});
