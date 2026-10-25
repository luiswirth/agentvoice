// The page's sounds: short cues for what happens, made in the browser from
// tones, with no files. They play through the page's one audio context, so
// the browser's echo cancellation knows them as the page's own output.
import { runningAudio } from "./audio.ts";

/** One tone of a cue: when it starts and how long it rings, in seconds. */
type Tone = {
	/** Its pitch, in semitones from A4. */
	pitch: number;
	at: number;
	length: number;
	/** How loud, from 0 to 1, before the cues' own volume. */
	gain?: number;
	/** Its pitch at the end, gliding there, in semitones from A4. */
	to?: number;
	wave?: OscillatorType;
};

/** A cue as its tones, all in D major's pentatonic scale (A4 is 0: B 2, D 5,
 * E 7, F♯ 9), so that any two sound well together, except for a problem.
 * The person's side sounds lower, the agent's higher, and turning on rises
 * where turning off falls. Nothing sounds below A4: a phone's speaker barely
 * plays it. */
const CUES = {
	// The person's own acts.
	press: [{ pitch: 21, at: 0, length: 0.03, gain: 0.4, wave: "triangle" }],
	listen: [
		{ pitch: 2, at: 0, length: 0.09 },
		{ pitch: 7, at: 0.07, length: 0.14 },
	],
	unlisten: [
		{ pitch: 7, at: 0, length: 0.09 },
		{ pitch: 2, at: 0.07, length: 0.14 },
	],
	speak: [
		{ pitch: 9, at: 0, length: 0.09 },
		{ pitch: 14, at: 0.07, length: 0.14 },
	],
	unspeak: [
		{ pitch: 14, at: 0, length: 0.09 },
		{ pitch: 9, at: 0.07, length: 0.14 },
	],
	// The person's first words are heard, and their turn has begun.
	speaking: [
		{ pitch: 2, at: 0, length: 0.06, gain: 0.6 },
		{ pitch: 9, at: 0.05, length: 0.1, gain: 0.6 },
	],
	sent: [{ pitch: 5, to: 17, at: 0, length: 0.12, gain: 0.6 }],
	dropped: [{ pitch: 9, to: 0, at: 0, length: 0.14, gain: 0.5 }],
	// The agent's side.
	read: [{ pitch: 19, at: 0, length: 0.12, gain: 0.45 }],
	working: [{ pitch: 14, at: 0, length: 0.3, gain: 0.25 }],
	// Between two messages read one after the other, so that each is heard
	// as a unit of its own.
	next: [
		{ pitch: 17, at: 0, length: 0.05, gain: 0.35 },
		{ pitch: 14, at: 0.05, length: 0.09, gain: 0.35 },
	],
	message: [
		{ pitch: 9, at: 0, length: 0.1, gain: 0.7 },
		{ pitch: 14, at: 0.08, length: 0.18, gain: 0.7 },
	],
	other: [{ pitch: 17, at: 0, length: 0.05, gain: 0.35, wave: "triangle" }],
	// The session.
	joined: [
		{ pitch: 5, at: 0, length: 0.12 },
		{ pitch: 7, at: 0.09, length: 0.12 },
		{ pitch: 14, at: 0.18, length: 0.2 },
	],
	left: [
		{ pitch: 14, at: 0, length: 0.12 },
		{ pitch: 7, at: 0.09, length: 0.12 },
		{ pitch: 5, at: 0.18, length: 0.2 },
	],
	problem: [
		{ pitch: 3, at: 0, length: 0.14, wave: "triangle" },
		{ pitch: 0, at: 0.12, length: 0.22, wave: "triangle" },
	],
} satisfies Record<string, Tone[]>;

export type Cue = keyof typeof CUES;

/** Called with every cue as it plays, as for the page's trace. */
let played: (cue: Cue) => void = () => {};
export function onPlay(listener: (cue: Cue) => void): void {
	played = listener;
}

/** How loud the cues are as a whole: well under speech. */
const VOLUME = 0.2;

const SOUNDS = "voice-sounds";

/** Whether the cues are on, as kept in this browser: on by default. */
export function soundsOn(): boolean {
	return localStorage.getItem(SOUNDS) !== "off";
}

/** Turns the cues on or off, in this browser. */
export function setSounds(on: boolean): void {
	localStorage.setItem(SOUNDS, on ? "on" : "off");
}

/** Plays a cue now, if cues are on and the page's audio runs: it never
 * starts the audio itself. */
export function play(cue: Cue): void {
	if (!soundsOn()) return;
	const audio = runningAudio();
	if (audio === null) return;
	played(cue);
	schedule(audio, cue, audio.currentTime + 0.01);
}

/** Schedules a cue on `audio` at `start`, by its clock. */
export function schedule(
	audio: BaseAudioContext,
	cue: Cue,
	start: number,
): void {
	for (const tone of CUES[cue] as Tone[]) ring(audio, tone, start);
}

/** Rings one tone: a quick attack and an exponential decay, as a struck bell. */
function ring(audio: BaseAudioContext, tone: Tone, start: number): void {
	const at = start + tone.at;
	const end = at + tone.length;
	const oscillator = new OscillatorNode(audio, {
		type: tone.wave ?? "sine",
		frequency: hertz(tone.pitch),
	});
	if (tone.to !== undefined)
		oscillator.frequency.exponentialRampToValueAtTime(hertz(tone.to), end);
	const envelope = new GainNode(audio, { gain: 0 });
	const peak = VOLUME * (tone.gain ?? 1);
	envelope.gain.setValueAtTime(0, at);
	envelope.gain.linearRampToValueAtTime(peak, at + 0.005);
	envelope.gain.exponentialRampToValueAtTime(0.0001, end);
	oscillator.connect(envelope).connect(audio.destination);
	oscillator.start(at);
	oscillator.stop(end + 0.02);
}

function hertz(pitch: number): number {
	return 440 * 2 ** (pitch / 12);
}
