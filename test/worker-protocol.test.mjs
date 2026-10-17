import test from "node:test";
import assert from "node:assert/strict";
import { runAudioWorker } from "../extensions/pi-blips/worker.ts";

/** A parent-port stand-in, so the worker protocol is testable without audio. */
function port() {
	const sent = [];
	let listener;
	return {
		sent,
		postMessage: (message) => sent.push(message),
		on: (_event, fn) => {
			listener = fn;
		},
		send: (message) => listener(message),
	};
}

test("pings are answered even before the context is ready", () => {
	const parent = port();
	runAudioWorker(parent);
	parent.send({ type: "ping", id: 7 });
	assert.deepEqual(parent.sent, [{ type: "pong", id: 7 }]);
});

test("audio commands before init are dropped, not queued into a missing engine", () => {
	const parent = port();
	runAudioWorker(parent);
	assert.doesNotThrow(() => {
		parent.send({ type: "note", voice: "text" });
		parent.send({ type: "wait", kind: "model" });
		parent.send({ type: "beat" });
		parent.send({ type: "master", master: 2 });
	});
	assert.deepEqual(parent.sent, []);
});
