// The cues: short sounds for what happens, made from tones, with no files.
// They are mixed into what the host plays, so that an echo canceller knows
// them as its own output, as it knows the speech.

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
	wave?: "sine" | "triangle";
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
	// No cue as the person starts speaking: it can only come once their words
	// are recognized, about a second in, where it sounds like a call to stop.
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

/** How loud the cues are as a whole: well under speech. */
const VOLUME = 0.2;

/** How long after it was asked for a cue may still start, in milliseconds:
 * a cue is for the moment, so one that can't sound by then, as while the
 * host plays nothing, is skipped. */
const MOMENT = 250;

/** How long a cue is kept after it ended, in seconds: as long as a host may
 * hold what it played before it plays it. */
const KEPT = 1;

/** The cues asked for and ringing, rendered into what the host plays. */
export class Cues {
	/** Cues asked for, not yet started, with when, by `performance.now()`. */
	private asked: { cue: Cue; at: number }[] = [];
	/** Cues ringing, with how far each is, in seconds. */
	private ringing: { cue: Cue; tones: Tone[]; time: number }[] = [];
	/** Called with each cue skipped, since it could not sound in time, and
	 * how late it would have been, in milliseconds. */
	skipped: (cue: Cue, late: number) => void = () => {};

	/** Called as a cue is asked for, for the host to drop what it holds, so
	 * that the cue sounds at once. */
	flush: () => void = () => {};

	ask(cue: Cue): void {
		this.asked.push({ cue, at: performance.now() });
		this.flush();
	}

	/** Takes back the last `seconds` rendered, which the host dropped
	 * unplayed: a cue that started in them starts again. */
	unrender(seconds: number): void {
		const now = performance.now();
		const ringing = [];
		for (const each of this.ringing) {
			each.time -= seconds;
			if (each.time >= 0) ringing.push(each);
			else this.asked.unshift({ cue: each.cue, at: now });
		}
		this.ringing = ringing;
	}

	/** Adds the next `out.length` samples of the cues, at `rate`, to `out`. */
	render(out: Float32Array, rate: number): void {
		const now = performance.now();
		for (const { cue, at } of this.asked.splice(0)) {
			if (now - at > MOMENT) {
				this.skipped(cue, Math.round(now - at));
				continue;
			}
			this.ringing.push({ cue, tones: CUES[cue] as Tone[], time: 0 });
		}
		const step = 1 / rate;
		for (const ringing of this.ringing) {
			for (const tone of ringing.tones) add(out, tone, ringing.time, step);
			ringing.time += out.length * step;
		}
		// A cue rings on for a while after it ends, as what may be taken back.
		this.ringing = this.ringing.filter(({ tones, time }) =>
			tones.some((tone) => time < tone.at + tone.length + KEPT),
		);
	}
}

/** Adds a tone to `out`, from `time` seconds into its cue on, a sample each
 * `step`: a quick attack and an exponential decay, as a struck bell. */
function add(out: Float32Array, tone: Tone, time: number, step: number): void {
	const { at, length } = tone;
	const peak = VOLUME * (tone.gain ?? 1);
	const from = hertz(tone.pitch);
	const ratio = hertz(tone.to ?? tone.pitch) / from;
	for (let i = 0; i < out.length; i++) {
		const t = time + i * step - at;
		if (t < 0 || t >= length) continue;
		// The phase, in cycles: the pitch glides exponentially over the tone.
		const cycles =
			ratio === 1
				? from * t
				: (from * length * (ratio ** (t / length) - 1)) / Math.log(ratio);
		const attack = 0.005;
		const envelope =
			t < attack
				? (peak * t) / attack
				: peak * (0.0001 / peak) ** ((t - attack) / (length - attack));
		out[i] = (out[i] ?? 0) + envelope * wave(tone.wave ?? "sine", cycles);
	}
}

function wave(shape: "sine" | "triangle", cycles: number): number {
	const s = Math.sin(2 * Math.PI * cycles);
	return shape === "sine" ? s : (2 / Math.PI) * Math.asin(s);
}

function hertz(pitch: number): number {
	return 440 * 2 ** (pitch / 12);
}
