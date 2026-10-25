// The page's trace of what voice does, for the person's own agent to read and
// fix voice from. Kept on the page from when it opens, across reloads of its
// tab, and sent into the
// session only while the person shares it, which is off until they turn it
// on: at once as they turn it on, and then with each message they send.

/** A trace of what voice did since the last one was sent, or since the page
 * opened. */
export const TRACE = "application/vnd.byoa.voice.trace+json";

export type TraceEvent = { time: string; event: string } & Record<
	string,
	unknown
>;

const SHARING = "voice-sharing-trace";

/** The most events kept, the oldest dropped first. */
const KEPT = 5_000;

export class Trace {
	/** Kept for the tab and the page's link, so that a reload keeps it and
	 * another session never gets it. */
	private readonly key = `voice-trace ${location.href}`;
	private events: TraceEvent[] = JSON.parse(
		sessionStorage.getItem(this.key) ?? "[]",
	);
	sharing = localStorage.getItem(SHARING) === "true";

	share(on: boolean): void {
		this.sharing = on;
		localStorage.setItem(SHARING, String(on));
	}

	event(event: string, data: Record<string, unknown> = {}): void {
		this.events.push({ time: new Date().toISOString(), event, ...data });
		if (this.events.length > KEPT) this.events.shift();
		this.keep();
	}

	/** The events since the last take, while shared, and none otherwise. */
	take(): TraceEvent[] {
		if (!this.sharing) return [];
		const events = this.events;
		this.events = [];
		this.keep();
		return events;
	}

	/** Past the storage's quota, the trace is kept in memory only. */
	private keep(): void {
		try {
			sessionStorage.setItem(this.key, JSON.stringify(this.events));
		} catch {}
	}
}
