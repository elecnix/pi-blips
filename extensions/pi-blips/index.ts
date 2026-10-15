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
 * token stream. Scheduling a Web Audio node is a synchronous, O(1) call.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BlipEngine, type Mode, type WaitPersonality } from "./engine.ts";
import { createWaitTracker } from "./wait.ts";

const CONFIG_PATH = process.env.PI_BLIPS_CONFIG ?? join(homedir(), ".config", "pi-blips.json");
const DENSITY_TICK_MS = 80;
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
	let ctx: import("node-web-audio-api").AudioContext | undefined;
	let engine: BlipEngine | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	// Decides which kind of dead air we are in, and owns the anchored 1 Hz pulse.
	// It only ever talks to the engine, and only in three verbs.
	const waiter = createWaitTracker(
		{
			begin: (kind) => engine?.wait(kind),
			beat: () => engine?.beat(),
			end: () => engine?.wait(null),
		},
		() => config.waitBeats && config.enabled,
		{ intervalMs: BEAT_INTERVAL_MS },
	);

	async function boot(mode: ExtensionContext["mode"]) {
		if (ctx || !config.enabled) return;
		if (config.interactiveOnly && mode !== "tui") return;
		try {
			// Lazy so a missing/broken audio backend cannot break extension loading.
			const { AudioContext } = await import("node-web-audio-api");
			ctx = new AudioContext();
			engine = new BlipEngine(ctx, {
				master: config.master,
				mode: config.mode,
				onEvent: EVENT_LOG ? (event) => appendFileSync(EVENT_LOG, `${event.kind} ${event.at.toFixed(3)} ${event.weight ?? 1}\n`) : undefined,
				onError: (error) => {
					warn(`audio device lost, blips disabled: ${String(error)}`);
					void shutdown();
				},
			});
			if (config.mode === "density") {
				ticker = setInterval(() => {
					try {
						engine?.flush();
					} catch (error) {
						warn(`density clock stopped: ${String(error)}`);
						stopTicker();
					}
				}, DENSITY_TICK_MS);
			}
			// The heartbeat is armed by the wait tracker when a wait begins, so no
			// free-running clock is needed here.
		} catch (error) {
			warn(`audio unavailable: ${String(error)}`);
			ctx = undefined;
			engine = undefined;
		}
	}

	function stopTicker() {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	}

	async function shutdown() {
		stopTicker();
		const doomed = ctx;
		ctx = undefined;
		engine = undefined;
		try {
			await doomed?.close();
		} catch {
			/* closing an already-dead context is not worth reporting */
		}
	}

	function applyMode(mode: Mode) {
		config = { ...config, mode };
		saveConfig(config);
		engine?.flush();
		stopTicker();
		if (engine) {
			engine.mode = mode;
			if (mode === "density") {
				ticker = setInterval(() => {
					try {
						engine?.flush();
					} catch (error) {
						warn(`density clock stopped: ${String(error)}`);
						stopTicker();
					}
				}, DENSITY_TICK_MS);
			}
		}
	}

	pi.on("session_start", (_event, sessionCtx) => {
		void boot(sessionCtx.mode);
	});
	pi.on("session_shutdown", () => shutdown());

	pi.on("message_update", (event) => {
		const delta = event.assistantMessageEvent.type;
		if (RAW_LOG) appendFileSync(RAW_LOG, `${delta} ${Date.now()}\n`);
		// The first delta of any kind means the provider answered: stop beating.
		if (delta.endsWith("_delta")) waiter.delta();
		// Structural deltas are already covered by the turn/tool events below.
		if (delta === "text_delta") engine?.note("text");
		else if (delta === "thinking_delta") engine?.note("thinking");
		else if (delta === "toolcall_delta") engine?.note("toolarg");
	});

	pi.on("agent_start", () => waiter.agentStart());
	pi.on("turn_start", () => waiter.turnStart());
	pi.on("tool_execution_start", (event) => {
		waiter.toolStart(event.toolCallId);
		engine?.note("toolcall");
	});
	pi.on("tool_execution_end", (event) => {
		waiter.toolEnd(event.toolCallId);
		engine?.note(event.isError ? "error" : "toolresult");
	});
	pi.on("turn_end", () => {
		waiter.turnEnd();
		engine?.note("turnend");
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const reason = (event.message as { stopReason?: string }).stopReason;
		if (reason === "error" || reason === "aborted") engine?.note("error");
	});
	pi.on("agent_end", () => {
		waiter.agentEnd();
		if (!VERBOSE) return;
		const stats = engine?.stats();
		if (stats) warn(`turn done: ${engine?.rate(1).toFixed(1)} blips/s, dropped ${stats.dropped}`);
	});

	pi.registerCommand("blips", {
		description: "Token-stream audio: on|off|mode <discrete|density>|volume <0-4>|wait <on|off>|test|status",
		handler: async (args, cmdCtx: ExtensionContext) => {
			const [sub, value] = args.trim().toLowerCase().split(/\s+/);
			switch (sub) {
				case "on":
					config = { ...config, enabled: true };
					saveConfig(config);
					await boot(cmdCtx.mode);
					break;
				case "off":
					config = { ...config, enabled: false };
					saveConfig(config);
					await shutdown();
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
					engine?.setMaster(level);
					break;
				}
				case "test": {
					if (!engine) {
						cmdCtx.ui.notify("blips: no audio device (see stderr)", "warning");
						return;
					}
					const seconds = engine.test();
					cmdCtx.ui.notify(`blips: 7 voices, then the wait heartbeat, over ${seconds.toFixed(1)}s`, "info");
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
				: ctx
					? `${ctx.state}, ${ctx.sampleRate} Hz, ${mode}, ${wait}`
					: config.interactiveOnly
						? `armed (TUI only), ${mode}, ${wait}`
						: "no device";
			const stats = engine?.stats();
			const tail = stats ? ` | fired ${Object.entries(stats.fired).map(([k, v]) => `${k}:${v}`).join(" ")} dropped ${stats.dropped}` : "";
			cmdCtx.ui.notify(`blips: ${state}${tail}`, "info");
		},
	});
}
