// What voice reads of a call: its log, the person's turns and the agents'
// messages, as the page's server has them from the agents' IO, their inboxes
// and outboxes (server/main.ts), and nothing of its own.

/** The name what the agent's ear hears comes from, as the person's. */
export const VOICE = "voice";

/** An entry of the log: what the ear heard, a note of the ear's or the
 * mouth's to the agent, or the agent's message to speak. */
export type Entry = {
	/** Its place in the log, from 1. */
	n: number;
	/** The item's file name. */
	id: string;
	from: string;
	kind: "heard" | "note" | "message";
	/** A MIME type. */
	type: string;
	/** When it was written, as an ISO 8601 date. */
	time: string;
	text?: string;
	/** Whether the text is all there is: a message may still grow. */
	whole: boolean;
	/** Where it is a file, which is never read aloud. */
	filename?: string;
};

/** Someone else in the call: the last entry heard they took in. */
export type Participant = { read: number };

/** What the page tells the agent, as the server makes it an event. */
export type Event =
	| {
			event: "speech";
			text: string;
			voices: (number | null)[];
			backchannel: boolean;
	  }
	| {
			event: "said";
			message: string;
			heard: string;
			whole: boolean;
			why?: "cut" | "skipped" | undefined;
			unheard?: string | undefined;
			by?: number | null | undefined;
	  }
	| { event: "state"; ear: boolean; mouth: boolean }
	| { event: "problem"; text: string };

/** What voice needs of a call: its log so far, each entry as it comes or
 * grows, with who is in it then, and telling the agent what happens. */
export type Session = {
	readonly log: Entry[];
	subscribe(subscriber: {
		/** An entry, `fresh` the first time, else as it grew. */
		entry?: (entry: Entry, fresh: boolean) => void;
		participants?: (participants: Record<string, Participant>) => void;
	}): () => void;
	send(event: Event): Promise<void>;
};

/** Whether a name is the agent's, not what is heard. */
export function agent(name: string): boolean {
	return name !== VOICE;
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

/** Whether an entry is one said in the call: heard, or a message the
 * speaker reads, never a file, and never one that starts with `@silent`,
 * which its sender meant to be read, not heard. */
export function spoken(entry: Entry): entry is Entry & { text: string } {
	return (
		entry.kind !== "note" &&
		entry.text !== undefined &&
		entry.filename === undefined &&
		(entry.type.startsWith("text/plain") ||
			entry.type.startsWith("text/markdown")) &&
		!/^\s*@silent\b/.test(entry.text)
	);
}
