// What voice reads of a Vibe Together session: chat's messages, as
// https://vibetogether.potentialhedge.com/specs/chat.md has them, and nothing
// of its own.

import type { Entry, Participant } from "../vt.ts";

export type { Entry, Participant };

/** What voice needs of a session: its log so far, each entry as it comes
 * with who is in it then, and sending the person's turns. */
export type Session = {
	readonly log: Entry[];
	subscribe(subscriber: {
		entry?: (entry: Entry) => void;
		participants?: (participants: Record<string, Participant>) => void;
	}): () => void;
	send(text: string): Promise<void>;
};

/** Whether a participant is an agent, named under its person, as
 * `luiswirth/claude`: the page is the person's ears and mouth toward the
 * agents, so it reads out only theirs, never another person's. */
export function agent(name: string): boolean {
	return name.includes("/");
}

/** The agents in the order they first spoke in `log`: an agent's place
 * picks the voice it is read with and the shade of the agent colour it shows
 * in. A reload keeps it, since the log holds the session from its start. */
export function speakers(log: Entry[]): string[] {
	const order: string[] = [];
	for (const entry of log)
		if (agent(entry.from) && spoken(entry) && !order.includes(entry.from))
			order.push(entry.from);
	return order;
}

/** Whether an entry is a chat message the speaker reads: never a file, any
 * entry with a filename, and never one that starts with `@silent`, which
 * its sender meant to wake no one. */
export function spoken(entry: Entry): entry is Entry & { text: string } {
	return (
		entry.text !== undefined &&
		entry.filename === undefined &&
		(entry.type.startsWith("text/plain") ||
			entry.type.startsWith("text/markdown")) &&
		!/^\s*@silent\b/.test(entry.text)
	);
}
