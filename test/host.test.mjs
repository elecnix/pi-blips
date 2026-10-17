import test from "node:test";
import assert from "node:assert/strict";
import { BlipHost } from "../extensions/pi-blips/host.ts";

/** A Worker stand-in: records what it was sent and can be terminated. */
class FakeWorker {
	constructor() {
		this.messages = [];
		this.listeners = [];
		this.terminated = false;
		this.unrefCalled = false;
	}
	postMessage(message) {
		this.messages.push(message);
	}
	terminate() {
		this.terminated = true;
		return Promise.resolve(0);
	}
	on(_event, listener) {
		this.listeners.push(listener);
		return this;
	}
	unref() {
		this.unrefCalled = true;
	}
	emit(message) {
		for (const listener of this.listeners) listener(message);
	}
	of(type) {
		return this.messages.filter((message) => message.type === type);
	}
}

/** A host on a manual clock, so the watchdog is deterministic. */
function harness(overrides = {}) {
	const workers = [];
	let now = 1000;
	let timer;
	let fatal;
	const host = new BlipHost({
		createWorker: () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		},
		mode: "discrete",
		master: 1,
		pingIntervalMs: 5000,
		pongTimeoutMs: 15000,
		maxRestarts: 2,
		now: () => now,
		setTimer: (fn) => {
			timer = fn;
			return 1;
		},
		clearTimer: () => {
			timer = undefined;
		},
		onFatal: (error) => {
			fatal = error;
		},
		...overrides,
	});
	return {
		host,
		workers,
		current: () => workers.at(-1),
		advance: (ms) => {
			now += ms;
		},
		/** Run the single armed watchdog step. */
		tick: () => timer?.(),
		armed: () => timer !== undefined,
		fatal: () => fatal,
	};
}

test("start spawns one unref'd worker and initialises it", () => {
	const { host, workers, current } = harness();
	host.start();
	assert.equal(workers.length, 1);
	assert.equal(current().unrefCalled, true);
	assert.deepEqual(current().of("init"), [{ type: "init", mode: "discrete", master: 1 }]);
	assert.equal(host.alive(), true);
});

test("blips reach the worker, and a pong keeps it alive", () => {
	const { host, current } = harness();
	host.start();
	host.note("text");
	host.wait("model");
	host.beat();
	current().emit({ type: "pong", id: 1 });
	assert.deepEqual(current().of("note"), [{ type: "note", voice: "text" }]);
	assert.deepEqual(current().of("wait"), [{ type: "wait", kind: "model" }]);
	assert.equal(current().of("beat").length, 1);
});

test("a worker that stops answering is terminated and replaced", () => {
	const { host, workers, current, advance, tick } = harness();
	host.start();
	const first = current();

	// Answer one probe, then go silent.
	current().emit({ type: "pong", id: 1 });
	advance(20_000);
	tick();

	assert.equal(first.terminated, true, "the wedged worker is terminated");
	assert.equal(workers.length, 2, "a fresh worker takes over");
	assert.equal(current(), workers[1]);
	assert.deepEqual(current().of("init"), [{ type: "init", mode: "discrete", master: 1 }]);
	assert.equal(host.restartsSoFar(), 1);
});

test("blips are dropped once the worker goes quiet instead of piling up in its inbox", () => {
	const { host, current, advance } = harness();
	host.start();
	advance(20_000);
	host.note("text");
	assert.equal(current().of("note").length, 0, "a wedged worker's inbox stays bounded");
});

test("a dead device stops audio for good rather than restarting into it", () => {
	const { host, current, tick, fatal } = harness();
	host.start();
	current().emit({ type: "dead", error: "device gone" });
	assert.equal(host.alive(), false);
	assert.match(String(fatal()), /device gone/);
	// The watchdog is disarmed, so a later tick cannot resurrect a dead device.
	tick();
	assert.equal(host.restartsSoFar(), 0);
});

test("repeated wedges stop after maxRestarts and report once", () => {
	const { host, current, advance, tick, armed, fatal } = harness();
	host.start();

	for (let i = 0; i < 3; i++) {
		advance(20_000);
		tick();
		// A healthy replacement would answer, but this simulation keeps it silent.
		current()?.emit({ type: "pong", id: 0 });
	}

	assert.equal(host.restartsSoFar(), 3, "three replacements were attempted");
	assert.equal(host.alive(), false);
	assert.match(String(fatal()), /wedged workers/);
	assert.equal(armed(), false, "the watchdog is disarmed after giving up");
});

test("close terminates the worker and disarms the watchdog", () => {
	const { host, current, armed } = harness();
	host.start();
	const worker = current();
	host.close();
	assert.equal(worker.terminated, true);
	assert.equal(host.alive(), false);
	assert.equal(armed(), false);
});
