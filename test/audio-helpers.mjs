/** Shared audio analysis for the tests: no device, no dependencies. */
export const SR = 48_000;

export function rms(data, from, to) {
	let sum = 0;
	let count = 0;
	for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
		sum += data[i] * data[i];
		count++;
	}
	return Math.sqrt(sum / count);
}

export function peak(data, from = 0, to = data.length / SR) {
	let worst = 0;
	for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) worst = Math.max(worst, Math.abs(data[i]));
	return worst;
}

/** Loudest frequency in [from, to) by brute-force DFT, to 10 Hz. */
export function loudestFrequency(data, from, to) {
	let best = 0;
	let bestMag = 0;
	for (let f = 100; f < 1600; f += 10) {
		let re = 0;
		let im = 0;
		for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
			const angle = (2 * Math.PI * f * i) / SR;
			re += data[i] * Math.cos(angle);
			im += data[i] * Math.sin(angle);
		}
		const mag = Math.hypot(re, im);
		if (mag > bestMag) {
			bestMag = mag;
			best = f;
		}
	}
	return best;
}
