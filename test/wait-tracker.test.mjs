import test from "node:test";
import assert from "node:assert/strict";
import { createWaitTracker } from "../extensions/pi-blips/wait.ts";

/** Records what the engine would have been told, so no audio is involved. */
/** A recording sink plus a manual clock, so the pulse schedule is deterministic. */
function tracker(enabled = true) {
	let on = enabled;
	const calls = [];
	const pending = new Map();
	const delays = [];
	let nextId = 1;
	const waiting = createWaitTracker(
		{
			begin: (kind) => calls.push(`begin:${kind}`),
			beat: () => calls.push("beat"),
			end: () => calls.push("end"),
		},
		() => on,
		{
			setTimer: (fn, ms) => {
				const id = nextId++;
				pending.set(id, fn);
				delays.push(ms);
				return id;
			},
			clearTimer: (id) => pending.delete(id),
		},
	);
	return {
		waiting,
		calls,
		delays,
		armed: () => [...pending.keys()],
		setEnabled: (value) => {
			on = value;
		},
		/** Run the single armed pulse. */
		tick() {
			const ids = [...pending.keys()];
			assert.equal(ids.length, 1, `expected exactly one armed pulse, got ${ids.length}`);
			const fn = pending.get(ids[0]);
			pending.delete(ids[0]);
			fn();
		},
	};
}

test("a normal turn: wait, answer, wait for the tool, answer", () => {
	const { waiting, calls } = tracker();

	waiting.turnStart();
	assert.equal(waiting.state(), "model");
	waiting.delta();
	assert.equal(waiting.state(), null, "the first delta ends the wait");
	waiting.toolStart("A");
	assert.equal(waiting.state(), "tool");
	waiting.toolEnd("A");
	assert.equal(waiting.state(), "model", "the provider is asked again after a tool");

	// Switching personality is a direct begin: the engine beats on the change, so
	// there is no `end` in between.
	assert.deepEqual(calls, ["begin:model", "end", "begin:tool", "begin:model"]);
});

test("parallel tools keep the tool personality until the last one returns", () => {
	const { waiting, calls } = tracker();

	waiting.delta(); // no wait state yet: must be a no-op
	waiting.toolStart("A");
	waiting.toolStart("B");
	waiting.toolStart("C");
	waiting.toolEnd("A");
	waiting.toolEnd("C");
	assert.equal(waiting.state(), "tool", "B is still running");
	waiting.toolEnd("B");
	assert.equal(waiting.state(), "model");

	assert.deepEqual(calls, ["begin:tool", "begin:model"]);
});

test("both agent_start and turn_start for one wait beat once", () => {
	const { waiting, calls } = tracker();

	waiting.agentStart();
	waiting.turnStart();
	waiting.turnStart();
	assert.deepEqual(calls, ["begin:model"]);
});

test("an idle agent is silent, and agent_end always stops the pulse", () => {
	const { waiting, calls } = tracker();

	waiting.agentEnd();
	waiting.delta();
	waiting.toolEnd("A");
	assert.deepEqual(calls, [], "nothing pending must reach the engine");

	// A turn boundary when nothing is pending starts nothing: the next request's
	// turn_start is what begins the wait.
	waiting.turnEnd();
	waiting.agentEnd();
	assert.deepEqual(calls, []);
	assert.equal(waiting.state(), null);
});

test("a tool that returns instantly re-beats the model, the engine's floor absorbs it", () => {
	const { waiting, calls } = tracker();

	waiting.turnStart();
	waiting.delta();
	waiting.toolStart("A");
	waiting.toolEnd("A");
	// The tracker is honest about the transition; the 0.5 s voice floor in the
	// engine is what stops this becoming a machine gun.
	assert.deepEqual(calls, ["begin:model", "end", "begin:tool", "begin:model"]);
});

test("disabling the feature stops the pulse and blocks new ones", () => {
	const { waiting, calls, armed, setEnabled } = tracker();

	waiting.turnStart();
	setEnabled(false);
	waiting.delta();
	waiting.turnStart();
	assert.deepEqual(calls, ["begin:model", "end"], "disabled means no new heartbeat");
	assert.deepEqual(armed(), [], "and nothing left ticking");

	setEnabled(true);
	waiting.toolStart("A");
	assert.equal(calls.at(-1), "begin:tool");
	assert.equal(armed().length, 1);
});

test("stop() is idempotent and leaves the tracker idle", () => {
	const { waiting, calls } = tracker();
	waiting.turnStart();
	waiting.stop();
	waiting.stop();
	assert.equal(waiting.state(), null);
	assert.deepEqual(calls, ["begin:model", "end"]);
});

test("the pulse is anchored to the state change: exactly 1 Hz from the change beat", () => {
	const { waiting, calls, delays, armed, tick } = tracker();

	waiting.turnStart();
	assert.deepEqual(calls, ["begin:model"], "the change beats at once");
	assert.equal(armed().length, 1, "and arms exactly one pulse");
	assert.deepEqual(delays, [1000]);

	for (let i = 0; i < 3; i++) tick();
	assert.deepEqual(calls, ["begin:model", "beat", "beat", "beat"], "one pulse per second");

	// A redundant transition must not arm a second pulse, which would double the rate.
	waiting.turnStart();
	waiting.agentStart();
	assert.deepEqual(calls, ["begin:model", "beat", "beat", "beat"]);
	assert.equal(armed().length, 1, "still exactly one pulse");
});

test("switching personality re-anchors the pulse instead of colliding with it", () => {
	const { waiting, calls, armed, tick } = tracker();

	waiting.turnStart();
	waiting.delta();
	assert.deepEqual(armed(), [], "no wait, no pulse");

	waiting.toolStart("A");
	assert.deepEqual(calls, ["begin:model", "end", "begin:tool"]);
	assert.equal(armed().length, 1);

	// A free-running clock would fire again somewhere arbitrary; an anchored one
	// is exactly one second after the beat that announced the tool.
	tick();
	assert.deepEqual(calls.at(-1), "beat");
	assert.deepEqual(calls, ["begin:model", "end", "begin:tool", "beat"]);
	assert.equal(armed().length, 1);
});

test("the pulse stops for good when the wait ends", () => {
	const { waiting, calls, armed, tick } = tracker();

	waiting.turnStart();
	tick();
	waiting.agentEnd();
	assert.deepEqual(calls, ["begin:model", "beat", "end"]);
	assert.deepEqual(armed(), [], "agent_end must leave no pending pulse");

	// Nothing can resurrect it without a new wait state.
	waiting.toolEnd("A");
	waiting.turnEnd();
	waiting.delta();
	assert.deepEqual(calls, ["begin:model", "beat", "end"]);
	assert.deepEqual(armed(), []);
});

test("switching during a wait leaves exactly one pulse armed", () => {
	const { waiting, armed, calls, tick } = tracker();

	waiting.turnStart();
	tick();
	waiting.toolStart("A"); // re-anchors
	waiting.toolStart("B"); // parallel: same personality, no re-anchor
	assert.deepEqual(calls, ["begin:model", "beat", "begin:tool"]);
	assert.equal(armed().length, 1, "a parallel tool must not double the pulse");
});
