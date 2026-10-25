// Voice's protocol, on chat's, on the byoa transport: two entries of its own,
// and nothing changed below.

import type { Session as Client, Entry } from "byoa/participant";

export type { Entry };

/** What voice needs of a session: the transport's client, or anything
 * else that sends, subscribes and keeps the log the same way. */
export type Session = Pick<Client, "send" | "subscribe" | "log">;

/** Which of the person's listener and speaker are on: sent as either changes. */
export const MODES = "application/vnd.byoa.voice.modes+json";
export type Modes = { listener: boolean; speaker: boolean };

/** What was heard of a message dropped as the person cut in, empty if none: sent before what cut it off. */
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
