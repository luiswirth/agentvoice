// Changes the sample rate of a stream, by windowed-sinc interpolation with
// its cutoff below the lower of the two Nyquist frequencies, so that going
// down does not alias. Its delay is the kernel's half width.
export class Resampler {
	// Input samples per output sample.
	private readonly step: number;
	// The kernel's half width, in input samples.
	private readonly half: number;
	// The kernel from 0 to `half`, `resolution` entries per input sample.
	private readonly kernel: Float32Array;
	private buffer: Float32Array;
	private length: number;
	// Where the next output sample lies, in input samples from buffer[0].
	private time: number;

	constructor(from: number, to: number, zeros = 16) {
		this.step = from / to;
		// Of the input's Nyquist frequency, a little below the lower one.
		const cutoff = 0.95 * Math.min(1, to / from);
		this.half = Math.ceil(zeros / cutoff);
		this.kernel = new Float32Array(this.half * resolution + 2);
		for (let i = 0; i < this.kernel.length; i++) {
			const x = i / resolution;
			const window =
				x >= this.half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * x) / this.half);
			this.kernel[i] = cutoff * sinc(cutoff * x) * window;
		}
		// Silence before the stream, so that the first output sample lies on
		// the first input sample.
		this.buffer = new Float32Array(4 * this.half + 4096);
		this.length = this.half;
		this.time = this.half;
	}

	// Takes input samples, and returns the output samples they complete.
	push(input: Float32Array): Float32Array {
		this.append(input);
		const count = Math.max(
			0,
			Math.ceil((this.length - this.half - this.time) / this.step),
		);
		const output = new Float32Array(count);
		for (let n = 0; n < count; n++) {
			output[n] = this.at(this.time);
			this.time += this.step;
		}
		const used = Math.floor(this.time - this.half);
		if (used > 0) {
			this.buffer.copyWithin(0, used, this.length);
			this.length -= used;
			this.time -= used;
		}
		return output;
	}

	private at(time: number): number {
		const { buffer, kernel, half } = this;
		let sum = 0;
		const first = Math.max(0, Math.ceil(time - half));
		const last = Math.min(this.length - 1, Math.floor(time + half));
		for (let k = first; k <= last; k++) {
			const x = Math.abs(time - k) * resolution;
			const i = Math.floor(x);
			const a = kernel[i] ?? 0;
			const b = kernel[i + 1] ?? 0;
			sum += (buffer[k] ?? 0) * (a + (b - a) * (x - i));
		}
		return sum;
	}

	private append(input: Float32Array): void {
		if (this.length + input.length > this.buffer.length) {
			const buffer = new Float32Array(2 * (this.length + input.length));
			buffer.set(this.buffer.subarray(0, this.length));
			this.buffer = buffer;
		}
		this.buffer.set(input, this.length);
		this.length += input.length;
	}
}

const resolution = 256;

function sinc(x: number): number {
	return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
}
