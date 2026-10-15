/**
 * Renders the two audio demos in assets/.
 *
 *   npm run demo
 *
 * Writes WAV, then converts to MP3 with ffmpeg when it is on PATH (GitHub plays
 * MP3 inline in the file view, and it keeps the repository small).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { OfflineAudioContext } from "node-web-audio-api";
import { BlipEngine } from "../extensions/pi-blips/engine.ts";

const SR = 48_000;
const OUT = new URL("../assets/", import.meta.url);
mkdirSync(OUT, { recursive: true });

function writeWav(name, data) {
	const pcm = Buffer.alloc(data.length * 2);
	for (let i = 0; i < data.length; i++) {
		pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), i * 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(SR, 24);
	header.writeUInt32LE(SR * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);

	const wav = new URL(name, OUT);
	writeFileSync(wav, Buffer.concat([header, pcm]));

	const ffmpeg = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav.pathname, "-b:a", "96k", wav.pathname.replace(/\.wav$/, ".mp3")]);
	if (ffmpeg.status === 0) {
		rmSync(wav);
		console.log(`assets/${name.replace(/\.wav$/, ".mp3")}`);
	} else {
		console.log(`assets/${name}  (ffmpeg unavailable, kept WAV)`);
	}
}

async function render(seconds, fill) {
	const ctx = new OfflineAudioContext(1, SR * seconds, SR);
	fill(new BlipEngine(ctx, { master: 1 }));
	const data = (await ctx.startRendering()).getChannelData(0);
	let peak = 0;
	for (const s of data) peak = Math.max(peak, Math.abs(s));
	return { data, peak };
}

// 1. Every voice once, in order: what /blips test plays.
const demo = await render(7, (engine) => engine.test(0.2));
writeWav("blips-test.wav", demo.data);
console.log(`  peak ${demo.peak.toFixed(3)} (${(20 * Math.log10(demo.peak)).toFixed(1)} dBFS)`);

// 2. The density clock, with throughput ramping 5 -> 100 tokens/s.
const ramp = await render(3.2, (engine) => {
	engine.mode = "density";
	const tick = 0.08;
	const rateAt = (t) => 5 + (95 * t) / 3.2;
	for (let t = tick; t < 3.2; t += tick) {
		for (let i = 0; i < Math.round(rateAt(t) * tick); i++) engine.note("text", 1, t);
		engine.flush(t);
	}
});
writeWav("density-ramp.wav", ramp.data);
console.log(`  peak ${ramp.peak.toFixed(3)} (${(20 * Math.log10(ramp.peak)).toFixed(1)} dBFS)`);
