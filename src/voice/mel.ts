// Whisper's log-mel spectrogram, as `transformers`' WhisperFeatureExtractor
// computes it with `do_normalize`, which Smart Turn hears.

const RATE = 16_000;
const FFT_SIZE = 400;
const HOP = 160;
const BINS = FFT_SIZE / 2 + 1;
export const MEL_BINS = 80;

/**
 * The features of `samples` at 16 kHz, mel bin by mel bin, `n / HOP` frames
 * each: the waveform scaled to zero mean and unit variance, a centered STFT
 * with a periodic Hann window and reflected padding, the power spectrum
 * through Slaney-style mel filters, log10 clamped to 8 below its peak, and
 * scaled by (x + 4) / 4. The STFT's last frame is dropped.
 */
export function logMel(samples: Float32Array): Float32Array {
	const n = samples.length;
	const frames = Math.floor(n / HOP);
	if (frames === 0) return new Float32Array(0);
	let mean = 0;
	for (const s of samples) mean += s;
	mean /= n;
	let variance = 0;
	for (const s of samples) variance += (s - mean) ** 2;
	variance /= n;
	const scale = 1 / Math.sqrt(variance + 1e-7);
	const pad = FFT_SIZE / 2;
	const padded = new Float64Array(n + 2 * pad);
	for (let i = 0; i < padded.length; i++)
		padded[i] = ((samples[reflect(i - pad, n)] ?? 0) - mean) * scale;

	const re = new Float64Array(FFT_SIZE);
	const im = new Float64Array(FFT_SIZE);
	const mel = new Float64Array(MEL_BINS * frames);
	let peak = Number.NEGATIVE_INFINITY;
	// Two real frames per complex transform: a's in the real part, b's in the
	// imaginary, told apart by symmetry.
	const power = [new Float64Array(BINS), new Float64Array(BINS)] as const;
	for (let a = 0; a < frames; a += 2) {
		const b = a + 1 < frames ? a + 1 : -1;
		for (let i = 0; i < FFT_SIZE; i++) {
			const w = WINDOW[i] ?? 0;
			re[i] = (padded[a * HOP + i] ?? 0) * w;
			im[i] = b < 0 ? 0 : (padded[b * HOP + i] ?? 0) * w;
		}
		FFT.transform(re, im);
		for (let k = 0; k < BINS; k++) {
			const zr = re[k] ?? 0;
			const zi = im[k] ?? 0;
			const cr = re[(FFT_SIZE - k) % FFT_SIZE] ?? 0;
			const ci = -(im[(FFT_SIZE - k) % FFT_SIZE] ?? 0);
			// A = (Z + conj Z') / 2, B = (Z - conj Z') / 2i.
			power[0][k] = ((zr + cr) ** 2 + (zi + ci) ** 2) / 4;
			power[1][k] = ((zi - ci) ** 2 + (zr - cr) ** 2) / 4;
		}
		for (const [which, frame] of [a, b].entries()) {
			if (frame < 0) continue;
			const spectrum = power[which as 0 | 1];
			for (let filter = 0; filter < MEL_BINS; filter++) {
				const [from, weights] = FILTERS[filter] ?? [0, new Float64Array(0)];
				let sum = 0;
				for (let k = 0; k < weights.length; k++)
					sum += (weights[k] ?? 0) * (spectrum[from + k] ?? 0);
				const value = Math.log10(Math.max(sum, 1e-10));
				mel[filter * frames + frame] = value;
				if (value > peak) peak = value;
			}
		}
	}
	const features = new Float32Array(mel.length);
	for (let i = 0; i < mel.length; i++)
		features[i] = (Math.max(mel[i] ?? 0, peak - 8) + 4) / 4;
	return features;
}

/**
 * A complex FFT of one size, in place, by mixed-radix decimation in time
 * over the size's prime factors.
 */
class Fft {
	private readonly n: number;
	private readonly factors: number[];
	private readonly cos: Float64Array;
	private readonly sin: Float64Array;
	/** The input's copy and the output. */
	private readonly scratch: Float64Array[][];
	/** Where each sub-transform's size combines. */
	private readonly temps = new Map<number, [Float64Array, Float64Array]>();

	constructor(n: number) {
		this.n = n;
		this.factors = [];
		for (let rest = n, p = 2; rest > 1; )
			if (rest % p === 0) {
				this.factors.push(p);
				rest /= p;
			} else p++;
		this.cos = new Float64Array(n);
		this.sin = new Float64Array(n);
		for (let k = 0; k < n; k++) {
			this.cos[k] = Math.cos((2 * Math.PI * k) / n);
			this.sin[k] = -Math.sin((2 * Math.PI * k) / n);
		}
		this.scratch = [0, 1].map(() =>
			Array.from({ length: 2 }, () => new Float64Array(n)),
		);
	}

	private temp(m: number): [Float64Array, Float64Array] {
		let temp = this.temps.get(m);
		if (temp === undefined) {
			temp = [new Float64Array(m), new Float64Array(m)];
			this.temps.set(m, temp);
		}
		return temp;
	}

	transform(re: Float64Array, im: Float64Array): void {
		const [inRe, inIm] = this.scratch[0] as [Float64Array, Float64Array];
		const [outRe, outIm] = this.scratch[1] as [Float64Array, Float64Array];
		inRe.set(re);
		inIm.set(im);
		this.step(inRe, inIm, 0, 1, outRe, outIm, 0, this.n, 0);
		re.set(outRe);
		im.set(outIm);
	}

	/** out[o + k] = Σ_j x[i + j·stride] e^{-2πi jk/m}, for k < m. */
	private step(
		xRe: Float64Array,
		xIm: Float64Array,
		i: number,
		stride: number,
		outRe: Float64Array,
		outIm: Float64Array,
		o: number,
		m: number,
		level: number,
	): void {
		if (m === 1) {
			outRe[o] = xRe[i] ?? 0;
			outIm[o] = xIm[i] ?? 0;
			return;
		}
		const p = this.factors[level] ?? m;
		const q = m / p;
		// The p sub-transforms of every p-th sample, side by side in `out`.
		for (let r = 0; r < p; r++)
			this.step(
				xRe,
				xIm,
				i + r * stride,
				stride * p,
				outRe,
				outIm,
				o + r * q,
				q,
				level + 1,
			);
		// Combined: X[k] = Σ_r e^{-2πi rk/m} Y_r[k mod q].
		const twiddle = this.n / m;
		const [tRe, tIm] = this.temp(m);
		for (let k = 0; k < m; k++) {
			let sumRe = 0;
			let sumIm = 0;
			const kq = k % q;
			for (let r = 0; r < p; r++) {
				const yRe = outRe[o + r * q + kq] ?? 0;
				const yIm = outIm[o + r * q + kq] ?? 0;
				const e = ((r * k) % m) * twiddle;
				const c = this.cos[e] ?? 0;
				const s = this.sin[e] ?? 0;
				sumRe += yRe * c - yIm * s;
				sumIm += yRe * s + yIm * c;
			}
			tRe[k] = sumRe;
			tIm[k] = sumIm;
		}
		outRe.set(tRe, o);
		outIm.set(tIm, o);
	}
}

const FFT = new Fft(FFT_SIZE);

const WINDOW = Float64Array.from(
	{ length: FFT_SIZE },
	(_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE),
);

/** Each triangular filter, area-normalized as Slaney's are, as the first bin
 * of its support and its weights there. */
const FILTERS: [number, Float64Array][] = (() => {
	const top = hertzToMel(8000);
	const edges = Array.from({ length: MEL_BINS + 2 }, (_, i) =>
		melToHertz((top * i) / (MEL_BINS + 1)),
	);
	return Array.from({ length: MEL_BINS }, (_, f) => {
		const low = edges[f] ?? 0;
		const center = edges[f + 1] ?? 0;
		const high = edges[f + 2] ?? 0;
		const norm = 2 / (high - low);
		const weights = Array.from({ length: BINS }, (_, bin) => {
			const hertz = (bin * RATE) / 2 / (BINS - 1);
			const down = (hertz - low) / (center - low);
			const up = (high - hertz) / (high - center);
			return Math.max(0, Math.min(down, up)) * norm;
		});
		const from = weights.findIndex((w) => w !== 0);
		const to = weights.findLastIndex((w) => w !== 0) + 1;
		return from < 0
			? [0, new Float64Array(0)]
			: [from, Float64Array.from(weights.slice(from, to))];
	});
})();

/** The index into `n` samples that `index` reflects to, mirrored at the
 * first and the last sample. */
function reflect(index: number, n: number): number {
	const period = 2 * (n - 1);
	if (period === 0) return 0;
	const i = ((index % period) + period) % period;
	return Math.min(i, period - i);
}

/** Slaney's mel scale: linear below 1 kHz, logarithmic above. */
function hertzToMel(hertz: number): number {
	return hertz < 1000
		? (3 * hertz) / 200
		: 15 + (27 * Math.log(hertz / 1000)) / Math.log(6.4);
}

function melToHertz(mel: number): number {
	return mel < 15
		? (200 * mel) / 3
		: 1000 * Math.exp((Math.log(6.4) * (mel - 15)) / 27);
}
