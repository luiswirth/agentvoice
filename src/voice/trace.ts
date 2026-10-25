// The page's trace of what voice does, for the person's own agent to read and
// fix voice from. Kept on the page from when it loads, and sent into the
// session only while the person shares it, which is off until they turn it
// on: at once as they turn it on, and then with each message they send.

/** A trace of what voice did since the last one was sent, or since the page
 * loaded. */
export const TRACE = "application/vnd.byoa.voice.trace+json";

export type TraceEvent = { time: string; event: string } & Record<
	string,
	unknown
>;

const SHARING = "voice-sharing-trace";

/** The most events kept, the oldest dropped first. */
const KEPT = 10_000;

export class Trace {
	private events: TraceEvent[] = [];
	sharing = localStorage.getItem(SHARING) === "true";

	share(on: boolean): void {
		this.sharing = on;
		localStorage.setItem(SHARING, String(on));
	}

	event(event: string, data: Record<string, unknown> = {}): void {
		this.events.push({ time: new Date().toISOString(), event, ...data });
		if (this.events.length > KEPT) this.events.shift();
	}

	/** The events since the last take, while shared, and none otherwise. */
	take(): TraceEvent[] {
		if (!this.sharing) return [];
		const events = this.events;
		this.events = [];
		return events;
	}
}
