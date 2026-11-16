// What the others in the session do, as far as the page can tell from the
// log and who is in it: who joins and leaves, whether they have read the
// person's last message, and whether they answered it. From reading it until
// answering, an agent is taken to be working on it.
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

const JOIN = "application/vnd.vibetogether.join";
const LEAVE = "application/vnd.vibetogether.leave";

export class Activity {
	private readonly name: string;
	private readonly events: ActivityEvents;
	/** The person's last message, by its entry, while no one answered it. */
	private waiting: number | null = null;
	private progress: Progress = null;
	readonly close: () => void;

	/** Starts with the session as it is: only what comes after is news. */
	constructor(session: Session, name: string, events: ActivityEvents) {
		this.name = name;
		this.events = events;
		this.close = session.subscribe({
			entry: (entry) => {
				if (entry.from === this.name) {
					if (!spoken(entry)) return;
					this.waiting = entry.n;
					this.set("sent");
				} else if (entry.type.startsWith(JOIN)) this.events.joined(entry.from);
				else if (entry.type.startsWith(LEAVE)) this.events.left(entry.from);
				else if (spoken(entry)) {
					this.waiting = null;
					this.set(null);
					this.events.message();
				} else if (!entry.type.includes("vnd.")) this.events.other();
			},
			participants: (participants) => this.participants(participants),
		});
	}

	private participants(participants: Record<string, Participant>): void {
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
