/**
 * The README art, generated from the real audio: one offline render of the
 * `/blips test` sequence, drawn twice — as a timeline from the engine's own
 * onset events, and as an envelope from the rendered samples.
 *
 *   npm run art
 */
import { OfflineAudioContext } from "node-web-audio-api";
import { BlipEngine, VOICES } from "../extensions/pi-blips/engine.ts";

const SR = 48_000;
const BUCKET = 0.2; // seconds per column
const RAMP = "▁▂▃▄▅▆▇█";

const ctx = new OfflineAudioContext(1, SR * 8, SR);
const engine = new BlipEngine(ctx, { master: 1 });
const onsets = [];
engine.onEvent = (event) => onsets.push({ voice: event.kind, at: event.at });
const seconds = engine.test(0.1);
const data = (await ctx.startRendering()).getChannelData(0);

// --- timeline: rows in order of first appearance, each blip as wide as it sounds.
const columns = Math.ceil((seconds + 0.2) / BUCKET);
const rows = [...new Set(onsets.map((o) => o.voice))];
const label = Math.max(...rows.map((r) => r.length)) + 2;

console.log(" ".repeat(label) + Array.from({ length: columns }, (_, i) => (i % 5 === 0 ? "|" : " ")).join(""));
for (const voice of rows) {
	const marks = new Set();
	for (const onset of onsets.filter((o) => o.voice === voice)) {
		const width = Math.max(1, Math.round(VOICES[voice].dur / BUCKET));
		for (let c = Math.floor(onset.at / BUCKET); c < Math.floor(onset.at / BUCKET) + width; c++) marks.add(c);
	}
	console.log(voice.padEnd(label) + Array.from({ length: columns }, (_, i) => (marks.has(i) ? "▓" : " ")).join(""));
}
console.log(`${" ".repeat(label)}one column = ${BUCKET}s, ticks are 1s, ${seconds.toFixed(1)}s total`);

// --- envelope: RMS as a sparkline, so the shape above is provably the audio below.
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
console.log(`one column ≈ ${Math.round((per / SR) * 1000)} ms · peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
