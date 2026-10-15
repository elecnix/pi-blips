import test from "node:test";
import assert from "node:assert/strict";
import { BlipEngine } from "../extensions/pi-blips/engine.ts";

// A stub device that throws on synthesis, the way a removed sink does.
const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
const passThrough = { connect: (x) => x };
const brokenDevice = {
	currentTime: 0,
	destination: passThrough,
	createGain: () => ({ gain: param(), ...passThrough }),
	createDynamicsCompressor: () => ({ threshold: param(), ratio: param(), attack: param(), release: param(), ...passThrough }),
	createOscillator: () => {
		throw new Error("device gone");
	},
};

test("a lost device reports once, then goes silent instead of throwing per token", () => {
	const errors = [];
	const engine = new BlipEngine(brokenDevice, { onError: (error) => errors.push(error) });

	assert.doesNotThrow(() => {
		for (let i = 0; i < 1000; i++) engine.note("text");
		engine.note("toolresult");
		engine.note("error");
	});

	assert.equal(errors.length, 1, "one report, not one per delta");
	assert.equal(String(errors[0]), "Error: device gone");
	assert.equal(engine.isDead(), true);
	assert.deepEqual(engine.stats().fired, {}, "nothing sounded");
});

test("a healthy device is never marked dead", async () => {
	const { OfflineAudioContext } = await import("node-web-audio-api");
	const engine = new BlipEngine(new OfflineAudioContext(1, 48_000, 48_000), { mode: "discrete" });
	engine.note("text");
	assert.equal(engine.isDead(), false);
	assert.equal(engine.stats().fired.text, 1);
});
