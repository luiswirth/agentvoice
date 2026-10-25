// Kaldi's log mel filterbank, as the speaker model was trained on: 25 ms
// frames every 10 ms, each with its DC offset removed, pre-emphasized, under
// a Povey window and padded to 512 for the power spectrum, through 80
// triangular mel filters from 20 Hz to 8 kHz, with no dither. Each bin's mean
// over the frames is subtracted.
import { Fft } from "./mel.ts";

const RATE = 16_000;
const LENGTH = 400;
const SHIFT = 160;
const PADDED = 512;
export const FBANK_BINS = 80;
const PREEMPHASIS = 0.97;
const LOW = 20;
const HIGH = RATE / 2;

const FFT = new Fft(PADDED);
const WINDOW = Float64Array.from(
	{ length: LENGTH },
	(_, i) => (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (LENGTH - 1))) ** 0.85,
);
const mel = (hertz: number) => 1127 * Math.log(1 + hertz / 700);
/** Each filter's weights over the spectrum's first `PADDED / 2` bins. */
const FILTERS: Float64Array[] = (() => {
	const low = mel(LOW);
	const step = (mel(HIGH) - low) / (FBANK_BINS + 1);
	return Array.from({ length: FBANK_BINS }, (_, filter) => {
		const left = low + filter * step;
		const center = left + step;
		const right = center + step;
		return Float64Array.from({ length: PADDED / 2 }, (_, k) => {
			const m = mel((k * RATE) / PADDED);
			if (m <= left || m >= right) return 0;
			return m <= center
				? (m - left) / (center - left)
				: (right - m) / (right - center);
		});
	});
})();

/** The features of `samples` at 16 kHz, frame by frame, `FBANK_BINS` each. */
export function fbank(samples: Float32Array): Float32Array {
	const frames =
		samples.length < LENGTH
			? 0
			: 1 + Math.floor((samples.length - LENGTH) / SHIFT);
	const features = new Float32Array(frames * FBANK_BINS);
	const re = new Float64Array(PADDED);
	const im = new Float64Array(PADDED);
	for (let f = 0; f < frames; f++) {
		const start = f * SHIFT;
		let mean = 0;
		for (let i = 0; i < LENGTH; i++) mean += samples[start + i] ?? 0;
		mean /= LENGTH;
		re.fill(0);
		im.fill(0);
		for (let i = LENGTH - 1; i >= 0; i--) {
			const s = (samples[start + i] ?? 0) - mean;
			const before = i > 0 ? (samples[start + i - 1] ?? 0) - mean : s;
			re[i] = (s - PREEMPHASIS * before) * (WINDOW[i] ?? 0);
		}
		FFT.transform(re, im);
		for (let filter = 0; filter < FBANK_BINS; filter++) {
			const weights = FILTERS[filter] ?? new Float64Array(0);
			let sum = 0;
			for (let k = 0; k < weights.length; k++) {
				const w = weights[k] ?? 0;
				if (w !== 0) sum += w * ((re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2);
			}
			features[f * FBANK_BINS + filter] = Math.log(Math.max(sum, 1.1920929e-7));
		}
	}
	for (let bin = 0; bin < FBANK_BINS; bin++) {
		let mean = 0;
		for (let f = 0; f < frames; f++)
			mean += features[f * FBANK_BINS + bin] ?? 0;
		mean /= frames;
		for (let f = 0; f < frames; f++) {
			const i = f * FBANK_BINS + bin;
			features[i] = (features[i] ?? 0) - mean;
		}
	}
	return features;
}
