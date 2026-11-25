// What voice reads of a call: its log, the person's turns and the agents'
// messages, as the page's server has them from the agents' IO, their inboxes
// and outboxes (server/main.ts), and nothing of its own.

/** An entry of the log, the person's or an agent's. */
export type Entry = {
	/** Its place in the log, from 1. */
	n: number;
	from: string;
	/** A MIME type. */
	type: string;
	/** When it was written, as an ISO 8601 date. */
	time: string;
	text?: string;
	/** Where it is a file, which is never read aloud. */
	filename?: string;
};

/** Someone else in the call: the person's last entry they took in. */
export type Participant = { read: number };

/** What voice needs of a call: its log so far, each entry as it comes
 * with who is in it then, and sending the person's turns. */
export type Session = {
	readonly log: Entry[];
	subscribe(subscriber: {
		entry?: (entry: Entry) => void;
		participants?: (participants: Record<string, Participant>) => void;
	}): () => void;
	send(text: string): Promise<void>;
};

/** Whether a name is an agent's: a person outside the agents is named by
 * their channel, as `voice:luis`, which no agent's name is. The page is the
 * person's ears and mouth toward the agents, so it reads out only theirs. */
export function agent(name: string): boolean {
	return !name.includes(":");
}

/** The agents in the order they first spoke in `log`: an agent's place
 * picks the voice it is read with and the shade of the agent colour it shows
 * in. A reload keeps it, since the log holds the call from its start. */
export function speakers(log: Entry[]): string[] {
	const order: string[] = [];
	for (const entry of log)
		if (agent(entry.from) && spoken(entry) && !order.includes(entry.from))
			order.push(entry.from);
	return order;
}

/** Whether an entry is a message the speaker reads: never a file, any
 * entry with a filename, and never one that starts with `@silent`, which
 * its sender meant to be read, not heard. */
export function spoken(entry: Entry): entry is Entry & { text: string } {
	return (
		entry.text !== undefined &&
		entry.filename === undefined &&
		(entry.type.startsWith("text/plain") ||
			entry.type.startsWith("text/markdown")) &&
		!/^\s*@silent\b/.test(entry.text)
	);
}
