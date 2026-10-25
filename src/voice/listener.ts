// The listener: what the person says, as text, from the microphone through
// Scribe. Turn detection runs in the page, on local models, and ends a
// segment once the person sounds done; whether a segment ends the person's
// turn is for whoever uses the listener to decide. A segment counts only
// once it is loud enough, so that the speaker's echo, which the browser's
// echo cancellation never removes entirely, is not taken for the person.
import { Microphone } from "./audio.ts";
import { LISTEN_RATE, Scribe } from "./elevenlabs.ts";
import type { FromTurns, ToTurns } from "./turns-worker.ts";
import TurnsWorker from "./turns-worker.ts?worker";

export type Hearing = {
	/** The person started saying something, which may still turn out to be no words. */
	speaking(): void;
	/** What was heard so far of the segment in progress. */
	partial(text: string): void;
	/** A segment ended, empty if it held no words or never counted. */
	segment(text: string): void;
	/** How loud the microphone is, from 0 to 1, every 0.1 s. */
	level(level: number): void;
	/** The listener stopped on its own. */
	failed(error: Error): void;
	/** What turn detection decided, for the trace. */
	trace(event: string, data: Record<string, unknown>): void;
};

/** The audio after which a pause commits what Scribe heard so far, since
 * Scribe commits on its own after about 36 s, wherever the person is. */
const PIECE = 20 * LISTEN_RATE;

/** What a commit is for: a piece of the turn in progress, its end, or the
 * sound between turns, which is dropped. */
type Commit = "piece" | "end" | "between";

export class Listener {
	private readonly microphone: Microphone;
	private readonly scribe: Scribe;
	private readonly worker: Worker;
	private readonly finishTurn: () => boolean;
	private closing = false;

	private constructor(
		microphone: Microphone,
		scribe: Scribe,
		worker: Worker,
		finishTurn: () => boolean,
	) {
		this.microphone = microphone;
		this.scribe = scribe;
		this.worker = worker;
		this.finishTurn = finishTurn;
	}

	/**
	 * `floor`: how loud, in dBFS, a segment's loudest 0.1 s must be for it to
	 * count, asked as it is heard. Call it from a click, since it starts the
	 * page's audio.
	 */
	static async open(
		key: string,
		hearing: Hearing,
		floor: () => number,
	): Promise<Listener> {
		let listener: Listener | null = null;
		/** Whether the segment in progress counts. */
		let speaking = false;
		/** The loudest 0.1 s of the segment in progress, in dBFS. */
		let loudest = Number.NEGATIVE_INFINITY;
		/** What Scribe committed of the segment in progress. */
		let pieces: string[] = [];
		/** The commits not yet answered, in order. */
		const commits: Commit[] = [];
		/** Whether turn detection hears a turn in progress. */
		let turn = false;
		const fail = (error: Error) => {
			if (listener === null || listener.closing) return;
			listener.close();
			hearing.failed(error);
		};
		const worker = new TurnsWorker();
		const tell = (message: ToTurns, transfer: Transferable[] = []) =>
			worker.postMessage(message, transfer);
		const segment = () => {
			const counts = speaking || loudest >= floor();
			const text = pieces.join(" ").trim();
			speaking = false;
			loudest = Number.NEGATIVE_INFINITY;
			pieces = [];
			hearing.segment(counts ? text : "");
		};
		/** Ends the segment in progress once Scribe settled it; whether it is still to come. */
		const finish = (): boolean => {
			turn = false;
			if (scribe.commit()) commits.push("end");
			else if (commits.length > 0) commits[commits.length - 1] = "end";
			else return false;
			return true;
		};
		const commit = (why: Commit) => {
			if (scribe.commit()) commits.push(why);
		};
		const ready = new Promise<void>((resolve, reject) => {
			worker.onmessage = ({ data }: MessageEvent<FromTurns>) => {
				switch (data.type) {
					case "ready":
						return resolve();
					case "failed":
						reject(new Error(`Turn detection failed: ${data.error}`));
						return fail(new Error(`Turn detection failed: ${data.error}`));
					case "speech":
						turn = true;
						return hearing.trace("vad.speech", { at: data.at });
					case "silence":
						hearing.trace("vad.silence", { at: data.at });
						if (turn && scribe.uncommitted >= PIECE) commit("piece");
						return;
					case "verdict":
						return hearing.trace("turn.verdict", {
							probability: data.probability,
							paused: data.paused,
						});
					case "ended":
						hearing.trace("turn.end", { reason: data.reason });
						if (!finish()) segment();
						return;
				}
			};
			worker.onerror = (event) => {
				reject(new Error(`Turn detection failed: ${event.message}`));
				fail(new Error(`Turn detection failed: ${event.message}`));
			};
		});
		let scribe: Scribe;
		try {
			[scribe] = await Promise.all([
				Scribe.open(key, {
					partial: (text) => {
						// It belongs to a segment being committed.
						if (commits.length > 0) return;
						const heard = [...pieces, text].join(" ").trim();
						tell({ type: "text", text: heard });
						if (!/\w/.test(text)) return;
						if (!speaking && loudest < floor()) return;
						if (!speaking) hearing.speaking();
						speaking = true;
						hearing.partial(heard);
					},
					committed: (text, automatic) => {
						const why = automatic ? "piece" : (commits.shift() ?? "piece");
						if (why !== "between" && text.trim()) pieces.push(text.trim());
						if (why === "end") segment();
					},
					closed: (error) => {
						if (error) fail(error);
					},
				}),
				ready,
			]);
		} catch (error) {
			worker.terminate();
			throw error;
		}
		let microphone: Microphone;
		try {
			microphone = await Microphone.open(
				(pcm) => {
					scribe.hear(pcm);
					const rms = root(pcm);
					loudest = Math.max(loudest, 20 * Math.log10(rms));
					hearing.level(Math.min(1, rms * 8));
					tell({ type: "audio", pcm: pcm.buffer as ArrayBuffer }, [pcm.buffer]);
					if (!turn && commits.length === 0 && scribe.uncommitted >= PIECE)
						commit("between");
				},
				() => fail(new Error("The microphone was cut off.")),
			);
		} catch (error) {
			scribe.close();
			worker.terminate();
			throw error;
		}
		listener = new Listener(microphone, scribe, worker, () => {
			tell({ type: "end" });
			const coming = finish();
			if (!coming) {
				speaking = false;
				loudest = Number.NEGATIVE_INFINITY;
				pieces = [];
			}
			return coming;
		});
		return listener;
	}

	/** Ends the segment in progress now, rather than once the person sounds
	 * done; whether its end is still to come. */
	finish(): boolean {
		return this.finishTurn();
	}

	close(): void {
		this.closing = true;
		this.microphone.close();
		this.scribe.close();
		this.worker.terminate();
	}
}

/** The root mean square of a chunk, from 0 to 1. */
function root(pcm: Int16Array): number {
	let sum = 0;
	for (const sample of pcm) sum += (sample / 32768) ** 2;
	return Math.sqrt(sum / pcm.length);
}
