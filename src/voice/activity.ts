// What the others in the session do, as far as the page can tell from the
// log and the presence: who joins and leaves, whether they have read the
// person's last message, and whether they answered it. From reading it until
// answering, an agent is taken to be working on it.
import { type Entry, JOIN, LEAVE, type Presence } from "byoa/participant";
import { HEARD, MODES, type Session, spoken } from "./protocol.ts";
import { TRACE } from "./trace.ts";

/** Where the person's last message is: sent, read by another, or answered. */
export type Progress = "sent" | "working" | null;

export type ActivityEvents = {
	/** Someone else read it: the agent is on it. */
	read(): void;
	/** Someone else sent a message to read. */
	message(): void;
	/** Someone else sent anything else, such as a file or the voices' names. */
	other(): void;
	joined(name: string): void;
	left(name: string): void;
	/** Where the person's last message is, as it changes. */
	progress(progress: Progress): void;
};

/** Entries the voice pages send about themselves, which are no one's acts. */
const PAGES = [MODES, HEARD, TRACE];

export class Activity {
	private readonly name: string;
	private readonly events: ActivityEvents;
	/** The person's last message, by its entry, while no one answered it. */
	private waiting: number | null = null;
	private progress: Progress = null;
	/** Whether entries are new, rather than the log so far. */
	private live: boolean;
	readonly close: () => void;

	constructor(session: Session, name: string, events: ActivityEvents) {
		this.name = name;
		this.events = events;
		// The log so far comes with the first receive, which ends at its
		// presence: until it did, the presence is empty.
		this.live = false;
		this.close = session.subscribe({
			entry: (entry) => this.live && this.entry(entry),
			presence: (presence) => {
				if (this.live) this.presence(presence);
				else this.live = Object.keys(presence).length > 0;
			},
		});
	}

	private entry(entry: Entry): void {
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
		} else if (!PAGES.some((type) => entry.type.startsWith(type)))
			this.events.other();
	}

	private presence(presence: Presence): void {
		if (this.waiting === null || this.progress !== "sent") return;
		const waiting = this.waiting;
		const read = Object.entries(presence).some(
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
