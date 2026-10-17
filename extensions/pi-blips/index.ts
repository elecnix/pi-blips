/**
 * Token-stream sonification for pi.
 *
 * A blip per streamed delta, with a distinct timbre per channel: output text,
 * extended thinking, tool-call arguments, tool call/result, turn end, error.
 *
 * Two modes, because token streams outrun human hearing:
 *   discrete - one blip per delta, rate-limited per voice (good for slow streams)
 *   density  - a fixed 12.5 Hz clock; amplitude and pitch track token throughput
 *
 * Every event handler here is synchronous. pi awaits `message_update` handlers
 * in stream order, so a handler that awaits or spawns a process would stall the
 * token stream. The audio itself lives in a worker (see host.ts and worker.ts),
 * so even a wedged audio call cannot stall a handler.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Mode } from "./engine.ts";
import { BlipHost } from "./host.ts";
import { createWaitTracker } from "./wait.ts";

const CONFIG_PATH = process.env.PI_BLIPS_CONFIG ?? join(homedir(), ".config", "pi-blips.json");
/** The wait heartbeat: one beat per second, as slow as a resting pulse. */
const BEAT_INTERVAL_MS = 1000;
const RAW_LOG = process.env.PI_BLIPS_RAW;
const EVENT_LOG = process.env.PI_BLIPS_LOG;
/** Per-turn counters draw over the TUI input box, so they are opt-in. */
const VERBOSE = Boolean(process.env.PI_BLIPS_VERBOSE);

interface Config {
	enabled: boolean;
	mode: Mode;
	master: number;
	/** Only make sound in the interactive TUI; stay silent in print/json/rpc runs. */
	interactiveOnly: boolean;
	/** Beat once a second while waiting on the provider or on a tool. */
	waitBeats: boolean;
}

const DEFAULTS: Config = { enabled: true, mode: "discrete", master: 1, interactiveOnly: true, waitBeats: true };

function warn(message: string) {
	process.stderr.write(`[blips] ${message}\n`);
}

function loadConfig(): Config {
	try {
		return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
	} catch {
		return { ...DEFAULTS };
	}
}

function saveConfig(config: Config) {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
	} catch (error) {
		warn(`could not save ${CONFIG_PATH}: ${String(error)}`);
	}
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let host: BlipHost | undefined;
	// Decides which kind of dead air we are in, and owns the anchored 1 Hz pulse.
	// It only ever talks to the audio worker, and only in three verbs.
	const waiter = createWaitTracker(
		{
			begin: (kind) => host?.wait(kind),
			beat: () => host?.beat(),
			end: () => host?.wait(null),
		},
		() => config.waitBeats && config.enabled,
		{ intervalMs: BEAT_INTERVAL_MS },
	);

	function boot(mode: ExtensionContext["mode"]) {
		if (host || !config.enabled) return;
		if (config.interactiveOnly && mode !== "tui") return;
		try {
			// The worker loads the audio backend lazily, so a missing or broken
			// device cannot break extension loading.
			host = new BlipHost({
				createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) as unknown as import("./host.ts").AudioWorker,
				mode: config.mode,
				master: config.master,
				log: EVENT_LOG,
				onFatal: (error) => {
					warn(`audio device lost, blips disabled: ${String(error)}`);
					shutdown();
				},
			});
			host.start();
		} catch (error) {
			warn(`audio unavailable: ${String(error)}`);
			host = undefined;
		}
	}

	function shutdown() {
		host?.close();
		host = undefined;
	}

	function applyMode(mode: Mode) {
		config = { ...config, mode };
		saveConfig(config);
		host?.setMode(mode);
	}

	pi.on("session_start", (_event, sessionCtx) => {
		boot(sessionCtx.mode);
	});
	pi.on("session_shutdown", () => shutdown());

	pi.on("message_update", (event) => {
		const delta = event.assistantMessageEvent.type;
		if (RAW_LOG) appendFileSync(RAW_LOG, `${delta} ${Date.now()}\n`);
		// The first delta of any kind means the provider answered: stop beating.
		if (delta.endsWith("_delta")) waiter.delta();
		// Structural deltas are already covered by the turn/tool events below.
		if (delta === "text_delta") host?.note("text");
		else if (delta === "thinking_delta") host?.note("thinking");
		else if (delta === "toolcall_delta") host?.note("toolarg");
	});

	pi.on("agent_start", () => waiter.agentStart());
	pi.on("turn_start", () => waiter.turnStart());
	pi.on("tool_execution_start", (event) => {
		waiter.toolStart(event.toolCallId);
		host?.note("toolcall");
	});
	pi.on("tool_execution_end", (event) => {
		waiter.toolEnd(event.toolCallId);
		host?.note(event.isError ? "error" : "toolresult");
	});
	pi.on("turn_end", () => {
		waiter.turnEnd();
		host?.note("turnend");
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const reason = (event.message as { stopReason?: string }).stopReason;
		if (reason === "error" || reason === "aborted") host?.note("error");
	});
	pi.on("agent_end", () => {
		waiter.agentEnd();
		if (!VERBOSE) return;
		warn(`turn done${host ? `, ${host.restartsSoFar()} worker restart(s)` : ""}`);
	});

	pi.registerCommand("blips", {
		description: "Token-stream audio: on|off|mode <discrete|density>|volume <0-4>|wait <on|off>|test|status",
		handler: async (args, cmdCtx: ExtensionContext) => {
			const [sub, value] = args.trim().toLowerCase().split(/\s+/);
			switch (sub) {
				case "on":
					config = { ...config, enabled: true };
					saveConfig(config);
					boot(cmdCtx.mode);
					break;
				case "off":
					config = { ...config, enabled: false };
					saveConfig(config);
					shutdown();
					break;
				case "mode":
					if (value !== "discrete" && value !== "density") {
						cmdCtx.ui.notify("usage: /blips mode <discrete|density>", "warning");
						return;
					}
					applyMode(value);
					break;
				case "volume": {
					const level = Number(value);
					if (!Number.isFinite(level)) {
						cmdCtx.ui.notify("usage: /blips volume <0-4>", "warning");
						return;
					}
					config = { ...config, master: level };
					saveConfig(config);
					host?.setMaster(level);
					break;
				}
				case "test": {
					if (!host?.alive()) {
						cmdCtx.ui.notify("blips: no audio device (see stderr)", "warning");
						return;
					}
					host.test();
					cmdCtx.ui.notify("blips: 7 voices, then the wait heartbeat, over ~5.5s", "info");
					return;
				}
				case "wait": {
					if (value !== "on" && value !== "off") {
						cmdCtx.ui.notify("usage: /blips wait <on|off>", "warning");
						return;
					}
					config = { ...config, waitBeats: value === "on" };
					saveConfig(config);
					if (value === "off") waiter.stop();
					break;
				}
				default:
					break;
			}

			const mode = `mode=${config.mode}, volume=${config.master}`;
			const wait = config.waitBeats ? `wait=${waiter.state() ?? "idle"}` : "wait=off";
			const state = !config.enabled
				? "off"
				: host?.alive()
					? `worker alive (${host.restartsSoFar()} restart${host.restartsSoFar() === 1 ? "" : "s"}), ${mode}, ${wait}`
					: config.interactiveOnly
						? `armed (TUI only), ${mode}, ${wait}`
						: "no device";
			cmdCtx.ui.notify(`blips: ${state}`, "info");
		},
	});
}
