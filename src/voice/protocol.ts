// Voice's protocol, on chat's, on the byoa transport: two entries of its own,
// and nothing changed below.

/** An entry of the log, as the transport's client gives it. */
export type Entry = {
	n: number;
	time: string;
	from: string;
	type: string;
	size: number;
	filename?: string;
	text?: string;
};

/** What voice needs of the transport's client, `Session` of `byoa/client`. */
export type Session = {
	send(
		body: string | Blob,
		options?: { type?: string; filename?: string },
	): Promise<number>;
	/** Replays the log so far, then goes live. */
	subscribe(handlers: { entry(entry: Entry): void }): () => void;
	readonly log: readonly Entry[];
};

/** Which of the person's listener and speaker are on: sent as either changes. */
export const MODES = "application/vnd.byoa.voice.modes+json";
export type Modes = { listener: boolean; speaker: boolean };

/** What was heard of a message the speaker cut off: sent before what cut it off. */
export const HEARD = "application/vnd.byoa.voice.heard+json";
export type Heard = { n: number; text: string };

/** Whether an entry is a chat message the speaker reads. */
export function spoken(entry: Entry): entry is Entry & { text: string } {
	return (
		entry.text !== undefined &&
		(entry.type.startsWith("text/plain") ||
			entry.type.startsWith("text/markdown"))
	);
}

/**
 * A message as it is read aloud: its paragraphs, without the markup that
 * would be read literally. Code blocks and images are left out.
 */
export function speech(text: string): string[] {
	return text
		.replace(/```[\s\S]*?(```|$)/g, "\n\n")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s*(#+|>|[-*+]|\d+[.)])\s+/gm, "")
		.replace(/[*_`~]+/g, "")
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
		.filter((paragraph) => /\w/.test(paragraph));
}
