// The page's audio: one context for the microphone and the speaker, at the
// device's own rate. Browsers start audio only from a user's gesture, so the
// context is resumed by a switch's click, and by the first gesture anywhere
// on the page, for the speaker that is on from the start.
import capture from "./capture.ts?worker&url";
import { SPEECH_RATE } from "./engines.ts";

let context: { audio: AudioContext; loaded: Promise<void> } | null = null;

for (const gesture of ["pointerdown", "keydown"])
	window.addEventListener(gesture, () => void context?.audio.resume(), {
		capture: true,
	});

/** The page's audio context, started or resumed: call it from a click. */
export function audioContext(): { audio: AudioContext; loaded: Promise<void> } {
	if (context === null) {
		const audio = new AudioContext();
		context = { audio, loaded: audio.audioWorklet.addModule(capture) };
	}
	void context.audio.resume();
	return context;
}

/** The page's audio context if it runs, else null: for what may sound only
 * once the page's audio was started. */
export function runningAudio(): AudioContext | null {
	return context?.audio.state === "running" ? context.audio : null;
}

// Safari derives the page's audio session from what is active, so the
// speaker would jump in volume as the microphone opens and closes. The page
// holds play-and-record while voice is in use, where the browser has audio
// sessions.
export function holdAudioSession(held: boolean): void {
	const session = (navigator as { audioSession?: { type: string } })
		.audioSession;
	if (session !== undefined) session.type = held ? "play-and-record" : "auto";
}

/**
 * The microphone, with the browser's echo cancellation, so that the
 * speaker's voice is not heard as the person's. Its audio goes to `hear` as
 * 16-bit PCM at 16 kHz.
 */
export class Microphone {
	private readonly stream: MediaStream;
	private readonly nodes: AudioNode[];

	private constructor(stream: MediaStream, nodes: AudioNode[]) {
		this.stream = stream;
		this.nodes = nodes;
	}

	/** Ended: called if the microphone stops on its own, as when the system takes it. */
	static async open(
		hear: (pcm: Int16Array) => void,
		ended: () => void,
	): Promise<Microphone> {
		const { audio, loaded } = audioContext();
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
		});
		for (const track of stream.getAudioTracks())
			track.addEventListener("ended", ended);
		await loaded;
		const source = audio.createMediaStreamSource(stream);
		const node = new AudioWorkletNode(audio, "capture", { numberOfOutputs: 1 });
		node.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) =>
			hear(new Int16Array(data));
		// A node reaching no destination may not be run, so it reaches one, silenced.
		const silent = new GainNode(audio, { gain: 0 });
		source.connect(node).connect(silent).connect(audio.destination);
		return new Microphone(stream, [source, node, silent]);
	}

	close(): void {
		for (const track of this.stream.getTracks()) track.stop();
		for (const node of this.nodes) node.disconnect();
	}
}

/** The volume speech plays at while the person may be starting to talk. */
const DUCKED = 0.25;

/** A stretch of a line's speech, and where it starts in the line, in seconds. */
type Stretch = { line: number; from: number; buffer: AudioBuffer };

/**
 * Plays lines of speech at `SPEECH_RATE`, each behind the one before, and
 * knows how much of each it played. The browser resamples.
 */
export class Player {
	private readonly audio: AudioContext;
	/** What is still to play, the first perhaps playing. */
	private queue: Stretch[] = [];
	/** The stretches scheduled, with when each starts, while it plays. */
	private scheduled: {
		stretch: Stretch;
		at: number;
		node: AudioBufferSourceNode;
	}[] = [];
	private end = 0;
	private paused = false;
	/** Every line plays through it, so that it can get quieter. */
	private readonly volume: GainNode;
	/** What plays, as it sounds, for `level`. */
	private readonly analyser: AnalyserNode;
	private readonly samples = new Float32Array(512);
	/** How far each line played, in seconds. */
	private readonly played = new Map<number, number>();
	/** The line at the head of the queue, as last told. */
	head: number | null = null;
	/** Called as the line at the head of the queue changes, with none once nothing is left. */
	changed: (line: number | null) => void = () => {};

	constructor() {
		this.audio = audioContext().audio;
		this.volume = new GainNode(this.audio);
		this.volume.connect(this.audio.destination);
		this.analyser = new AnalyserNode(this.audio, { fftSize: 512 });
		this.volume.connect(this.analyser);
	}

	/** How loud it plays now, from 0 to 1, scaled as the microphone's level. */
	level(): number {
		this.analyser.getFloatTimeDomainData(this.samples);
		let sum = 0;
		for (const sample of this.samples) sum += sample * sample;
		return Math.min(1, Math.sqrt(sum / this.samples.length) * 8);
	}

	/** Plays on quieter, or at full volume again. */
	duck(ducked: boolean): void {
		this.volume.gain.setTargetAtTime(
			ducked ? DUCKED : 1,
			this.audio.currentTime,
			0.03,
		);
	}

	/** Queues samples of a line, starting `from` seconds into it. */
	play(line: number, from: number, samples: Float32Array): void {
		if (samples.length === 0) return;
		const buffer = new AudioBuffer({
			length: samples.length,
			sampleRate: SPEECH_RATE,
		});
		buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
		const stretch = { line, from, buffer };
		this.queue.push(stretch);
		if (!this.paused) this.schedule(stretch);
		this.notify();
	}

	get playing(): boolean {
		return this.queue.length > 0 && !this.paused;
	}

	/** Seconds of the line played so far. */
	progress(line: number): number {
		this.account();
		return this.played.get(line) ?? 0;
	}

	pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.account();
		const now = this.audio.currentTime;
		// The stretch playing goes on later from where it stopped.
		const playing = this.scheduled.find(({ at }) => at <= now);
		if (playing !== undefined) {
			const into = now - playing.at;
			const { buffer, line, from } = playing.stretch;
			const start = Math.floor(into * SPEECH_RATE);
			const rest = new AudioBuffer({
				length: Math.max(1, buffer.length - start),
				sampleRate: SPEECH_RATE,
			});
			rest.copyToChannel(buffer.getChannelData(0).subarray(start), 0);
			this.queue[0] = { line, from: from + into, buffer: rest };
		}
		this.unschedule();
	}

	resume(): void {
		if (!this.paused) return;
		this.paused = false;
		void this.audio.resume();
		for (const stretch of this.queue) this.schedule(stretch);
	}

	/** Drops everything still to play, or only what is left of one line. */
	stop(line?: number): void {
		const paused = this.paused;
		this.pause();
		this.queue =
			line === undefined ? [] : this.queue.filter((s) => s.line !== line);
		if (!paused) this.resume();
		this.notify();
	}

	private schedule(stretch: Stretch): void {
		const node = new AudioBufferSourceNode(this.audio, {
			buffer: stretch.buffer,
		});
		node.connect(this.volume);
		const at = Math.max(this.end, this.audio.currentTime + 0.02);
		this.end = at + stretch.buffer.duration;
		this.scheduled.push({ stretch, at, node });
		node.onended = () => {
			if (this.paused || !this.scheduled.some((s) => s.node === node)) return;
			this.account();
		};
		node.start(at);
	}

	private unschedule(): void {
		for (const { node } of this.scheduled) {
			node.onended = null;
			node.stop();
			node.disconnect();
		}
		this.scheduled = [];
		this.end = 0;
	}

	/** Moves what played out of the queue, into the lines' progress. */
	private account(): void {
		const now = this.audio.currentTime;
		for (const { stretch, at } of this.scheduled) {
			const into = Math.min(Math.max(now - at, 0), stretch.buffer.duration);
			if (into === 0) continue;
			const reached = stretch.from + into;
			if (reached > (this.played.get(stretch.line) ?? 0))
				this.played.set(stretch.line, reached);
		}
		while (this.scheduled[0] !== undefined) {
			const { stretch, at } = this.scheduled[0];
			if (at + stretch.buffer.duration > now) break;
			this.scheduled.shift();
			if (this.queue[0] === stretch) this.queue.shift();
		}
		this.notify();
	}

	private notify(): void {
		const head = this.queue[0]?.line ?? null;
		if (head === this.head) return;
		this.head = head;
		this.changed(head);
	}
}
