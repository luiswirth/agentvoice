// The page's trace of what voice does, for the person's own agent to read and
// fix voice from. Kept only while the person shares it, which is off until
// they turn it on, and sent into the session with each message they send.

/** A trace of what voice did since the person's last message: sent before it. */
export const TRACE = "application/vnd.byoa.voice.trace+json";

export type TraceEvent = { time: string; event: string } & Record<
	string,
	unknown
>;

const SHARING = "voice-sharing-trace";

export class Trace {
	private events: TraceEvent[] = [];
	sharing = localStorage.getItem(SHARING) === "true";

	share(on: boolean): void {
		this.sharing = on;
		localStorage.setItem(SHARING, String(on));
		if (!on) this.events = [];
	}

	event(event: string, data: Record<string, unknown> = {}): void {
		if (this.sharing)
			this.events.push({ time: new Date().toISOString(), event, ...data });
	}

	/** The events since the last take. */
	take(): TraceEvent[] {
		const events = this.events;
		this.events = [];
		return events;
	}
}
