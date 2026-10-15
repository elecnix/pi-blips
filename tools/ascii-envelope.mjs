/**
 * The README art, generated from the real audio and the real voice table.
 *
 *   npm run art
 */
import { OfflineAudioContext } from "node-web-audio-api";
import { BlipEngine, VOICES } from "../extensions/pi-blips/engine.ts";

const SR = 48_000;
const RAMP = "▁▂▃▄▅▆▇█";

// --- timeline: one row per voice, from the engine's own /blips test schedule.
const VOICE_ORDER = ["text", "thinking", "toolarg", "toolcall", "toolresult", "turnend", "error"];
const SPACING = 0.4;
const START = 0.1;
const COLUMNS = 56;
const BUCKET = 0.05;

console.log("voice        " + Array.from({ length: COLUMNS }, (_, i) => (i % 10 === 0 ? "|" : " ")).join(""));
for (const [index, voice] of VOICE_ORDER.entries()) {
	const at = START + index * SPACING;
	const width = Math.max(1, Math.round(VOICES[voice].dur / BUCKET));
	const cells = Array.from({ length: COLUMNS }, (_, i) => {
		const columnTime = i * BUCKET;
		return columnTime >= at - 1e-9 && columnTime < at + width * BUCKET ? "▓" : " ";
	});
	console.log(voice.padEnd(12) + cells.join(""));
}
console.log(`             ${SPACING.toFixed(1)}s apart, ticks are 0.5s`);

// --- envelope: RMS of the rendered /blips test, as a sparkline.
const ctx = new OfflineAudioContext(1, SR * 3, SR);
new BlipEngine(ctx, { master: 1 }).test(START);
const data = (await ctx.startRendering()).getChannelData(0);

const buckets = 104;
const per = Math.floor(data.length / buckets);
const levels = [];
let peak = 0;
for (let b = 0; b < buckets; b++) {
	let sum = 0;
	for (let i = b * per; i < (b + 1) * per; i++) {
		sum += data[i] * data[i];
		peak = Math.max(peak, Math.abs(data[i]));
	}
	levels.push(Math.sqrt(sum / per));
}
const loudest = Math.max(...levels);
console.log("\n" + levels.map((l) => (l < 1e-6 ? " " : RAMP[Math.min(7, Math.floor((l / loudest) * 8))])).join(""));
console.log(`one column ≈ 30 ms · peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
