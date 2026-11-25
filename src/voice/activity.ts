// What the agent does, as far as the page can tell from the log and whether
// it is in voice mode: whether it comes or goes, whether it has taken in
// what was heard last, and whether it answered it. From taking it in
// until answering, an agent is taken to be working on it.
import type { Participant, Session } from "./protocol.ts";
import { spoken } from "./protocol.ts";

/** Where the person's last message is: sent, read by another, or answered. */
export type Progress = "sent" | "working" | null;

export type ActivityEvents = {
	/** Someone else read it: the agent is on it. */
	read(): void;
	/** Someone else sent a message to read. */
	message(): void;
	/** Someone else sent anything else, such as a file. */
	other(): void;
	joined(name: string): void;
	left(name: string): void;
	/** Where the person's last message is, as it changes. */
	progress(progress: Progress): void;
};

export class Activity {
	private readonly name: string;
	private readonly events: ActivityEvents;
	/** The person's last message, by its entry, while no one answered it. */
	private waiting: number | null = null;
	private progress: Progress = null;
	/** Who else is in the call, as last seen. */
	private present: Set<string> | null = null;
	readonly close: () => void;

	/** Starts with the session as it is: only what comes after is news. */
	constructor(session: Session, name: string, events: ActivityEvents) {
		this.name = name;
		this.events = events;
		this.close = session.subscribe({
			entry: (entry, fresh) => {
				if (!fresh) return;
				if (entry.from === this.name) {
					if (!spoken(entry)) return;
					this.waiting = entry.n;
					this.set("sent");
				} else if (spoken(entry)) {
					this.waiting = null;
					this.set(null);
					this.events.message();
				} else this.events.other();
			},
			participants: (participants) => this.participants(participants),
		});
	}

	private participants(participants: Record<string, Participant>): void {
		const present = new Set(
			Object.keys(participants).filter((name) => name !== this.name),
		);
		// Who was there as the page came is no news.
		if (this.present !== null) {
			for (const name of present)
				if (!this.present.has(name)) this.events.joined(name);
			for (const name of this.present)
				if (!present.has(name)) this.events.left(name);
		}
		this.present = present;
		if (this.waiting === null || this.progress !== "sent") return;
		const waiting = this.waiting;
		const read = Object.entries(participants).some(
			([name, { read }]) => name !== this.name && read >= waiting,
		);
		if (!read) return;
		this.set("working");
		this.events.read();
	}

	private set(progress: Progress): void {
		if (progress === this.progress) return;
		this.progress = progress;
		this.events.progress(progress);
	}
}
