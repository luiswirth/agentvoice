// Voice's protocol, on chat's, on the polylogue transport: entries of its own,
// and nothing changed below.

import type { Session as Client, Entry } from "polylogue/participant";

export type { Entry };

/** What voice needs of a session: the transport's client, or anything
 * else that sends, subscribes and keeps the log the same way. */
export type Session = Pick<Client, "send" | "subscribe" | "log" | "fetch">;

/** Which of the person's listener and speaker are on, and the tier they
 * chose: sent as any of them changes. */
export const MODES = "application/vnd.polylogue.voice.modes+json";
export type Modes = {
	listener: boolean;
	speaker: boolean;
	tier: "elevenlabs" | "local";
};

/** What was heard of message `n` dropped as the person cut in, empty if none. */
export type Heard = { n: number; text: string };

/** Who the voices are, by the number of their tag, as the agent names them:
 * the latest one holds. A named voice can cut in, and once any is named, an
 * unnamed one can't. */
export const NAMES = "application/vnd.polylogue.voice.names+json";
export type Names = Record<string, string>;

/** The names an entry holds: none where it is no object of names. */
export function names(text: string | undefined): Names {
	try {
		const parsed: unknown = JSON.parse(text ?? "{}");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return {};
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] =>
					/^\d+$/.test(entry[0]) &&
					typeof entry[1] === "string" &&
					entry[1].trim() !== "",
			),
		);
	} catch {
		return {};
	}
}

/** Whether an entry is a chat message the speaker reads: never a file, which
 * speech makes of any entry with a filename. */
export function spoken(entry: Entry): entry is Entry & { text: string } {
	return (
		entry.text !== undefined &&
		entry.filename === undefined &&
		(entry.type.startsWith("text/plain") ||
			entry.type.startsWith("text/markdown"))
	);
}

/**
 * A message as it is read aloud: its paragraphs, without the markup that
 * would be read literally. Code blocks and images are left out.
 */
export function speech(text: string): string[] {
	return (
		text
			.replace(/```[\s\S]*?(```|$)/g, "\n\n")
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			// A list item or a heading ends as a sentence, so that it is heard as one.
			.replace(/^\s*(#+|[-*+]|\d+[.)])\s+(.*?)\s*$/gm, (_, _marker, line) =>
				/[\p{L}\p{N})][*_`~]*$/u.test(line) ? `${line}.` : line,
			)
			.replace(/^\s*>\s+/gm, "")
			.replace(/[*_`~]+/g, "")
			.split(/\n\s*\n/)
			.map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
			.filter((paragraph) => /\w/.test(paragraph))
	);
}
