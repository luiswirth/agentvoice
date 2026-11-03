// The page's audio: one context for the microphone and the speaker, at the
// device's own rate. Browsers start audio only from a user's gesture, so the
// context is resumed by a switch's click, and by any gesture anywhere on the
// page, for the speaker that is on from the start. A touch counts only as it
// ends, so its pointerdown alone starts nothing on a phone.
import { LISTEN_RATE, SPEECH_RATE } from "voice-core";
import type { FromPlayback } from "./capture.ts";
import capture from "./capture.ts?worker&url";

let context: { audio: AudioContext; loaded: Promise<void> } | null = null;
/** Called as the context starts or stops running. */
const watchers = new Set<() => void>();

for (const gesture of ["pointerdown", "pointerup", "touchend", "keydown"])
	window.addEventListener(gesture, () => void context?.audio.resume(), {
		capture: true,
	});

/** The page's audio context, started or resumed: call it from a click. */
export function audioContext(): { audio: AudioContext; loaded: Promise<void> } {
	if (context === null) {
		const audio = new AudioContext();
		context = { audio, loaded: audio.audioWorklet.addModule(capture) };
		audio.addEventListener("statechange", () => {
			for (const watcher of watchers) watcher();
		});
		for (const watcher of watchers) watcher();
	}
	void context.audio.resume();
	return context;
}

/** Whether the browser holds the page's audio, which a gesture on the page
 * starts: nothing it plays is heard, and the microphone hears nothing. */
export function audioBlocked(): boolean {
	return context !== null && context.audio.state !== "running";
}

/** Calls `watcher` as `audioBlocked` may have changed, until the returned
 * function is called. */
export function watchAudio(watcher: () => void): () => void {
	watchers.add(watcher);
	return () => watchers.delete(watcher);
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
 * speaker's voice is not heard as the person's. Its audio goes to `hear` at
 * `LISTEN_RATE`, 0.1 s at a time.
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
		hear: (pcm: Float32Array, rate: number) => void,
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
			hear(new Float32Array(data), LISTEN_RATE);
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

type OutputHandlers = {
	play: (out: Float32Array, rate: number, played: number) => void;
	dropped: (samples: number) => void;
	/** Called with how many samples the device had nothing to play for in
	 * all, as that grows. */
	short: (samples: number) => void;
};

/** What the page plays: `play` renders it as the device asks for it, at
 * `SPEECH_RATE`, a little ahead; `flush` drops what the device holds of it,
 * and gives back how much with `dropped`. */
export class Output {
	private node: AudioWorkletNode | null = null;
	private closed = false;
	private readonly handlers: OutputHandlers;

	constructor(handlers: OutputHandlers) {
		this.handlers = handlers;
		const { audio, loaded } = audioContext();
		void loaded.then(() => {
			if (this.closed) return;
			const node = new AudioWorkletNode(audio, "playback", {
				numberOfInputs: 0,
				outputChannelCount: [1],
			});
			node.port.onmessage = ({ data }: MessageEvent<FromPlayback>) => {
				if ("short" in data) return handlers.short(data.short);
				if ("dropped" in data) return handlers.dropped(data.dropped);
				const out = new Float32Array(data.need);
				handlers.play(out, SPEECH_RATE, data.played);
				node.port.postMessage(out.buffer, [out.buffer]);
			};
			node.connect(audio.destination);
			this.node = node;
		});
	}

	/** Drops what the device holds and has not played. */
	flush(): void {
		if (this.node === null) this.handlers.dropped(0);
		else this.node.port.postMessage("drop");
	}

	close(): void {
		this.closed = true;
		this.node?.disconnect();
		this.node = null;
	}
}
