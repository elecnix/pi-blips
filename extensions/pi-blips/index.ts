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
import { BlipEngine, type Mode } from "./engine.ts";

const CONFIG_PATH = process.env.PI_BLIPS_CONFIG ?? join(homedir(), ".config", "pi-blips.json");
const DENSITY_TICK_MS = 80;
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
}

const DEFAULTS: Config = { enabled: true, mode: "discrete", master: 1, interactiveOnly: true };

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
		// Structural deltas are already covered by the turn/tool events below.
		if (delta === "text_delta") engine?.note("text");
		else if (delta === "thinking_delta") engine?.note("thinking");
		else if (delta === "toolcall_delta") engine?.note("toolarg");
	});

	pi.on("tool_execution_start", () => engine?.note("toolcall"));
	pi.on("tool_execution_end", (event) => engine?.note(event.isError ? "error" : "toolresult"));
	pi.on("turn_end", () => engine?.note("turnend"));
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const reason = (event.message as { stopReason?: string }).stopReason;
		if (reason === "error" || reason === "aborted") engine?.note("error");
	});
	pi.on("agent_end", () => {
		if (!VERBOSE) return;
		const stats = engine?.stats();
		if (stats) warn(`turn done: ${engine?.rate(1).toFixed(1)} blips/s, dropped ${stats.dropped}`);
	});

	pi.registerCommand("blips", {
		description: "Token-stream audio: on|off|mode <discrete|density>|volume <0-4>|test|status",
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
					cmdCtx.ui.notify(`blips: playing all 7 voices over ${seconds.toFixed(1)}s`, "info");
					return;
				}
				default:
					break;
			}

			const state = !config.enabled
				? "off"
				: ctx
					? `${ctx.state}, ${ctx.sampleRate} Hz, mode=${config.mode}, volume=${config.master}`
					: config.interactiveOnly
						? `armed (TUI only), mode=${config.mode}`
						: "no device";
			const stats = engine?.stats();
			const tail = stats ? ` | fired ${Object.entries(stats.fired).map(([k, v]) => `${k}:${v}`).join(" ")} dropped ${stats.dropped}` : "";
			cmdCtx.ui.notify(`blips: ${state}${tail}`, "info");
		},
	});
}
