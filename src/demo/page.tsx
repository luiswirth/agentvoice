// The call without a session, at /demo: a fake voice whose levels move as
// speech would, and whose buttons work, the agent answering a message sent as
// a real one would. `?state=` starts it in a state of states.ts, as the
// bench's gallery does.
import { createRoot } from "react-dom/client";
import "../index.css";
import { Call, type Room } from "../voice/call.tsx";
import type { Voice, VoiceState } from "../voice/voice.ts";
import { base, states } from "./states.ts";

const name = new URLSearchParams(location.search).get("state");
let state: VoiceState = { ...base, ...states[name ?? "conversation"] };
const t0 = performance.now();
/** Speech-like: syllables under a slower swell. */
const speech = (phase: number) => {
	const t = (performance.now() - t0) / 1000 + phase;
	return Math.min(
		1,
		Math.abs(Math.sin(t * 9)) * (0.25 + 0.6 * Math.abs(Math.sin(t * 1.7))),
	);
};
const watchers = new Set<() => void>();
const set = (change: Partial<VoiceState>) => {
	state = { ...state, ...change };
	voice.state = state;
	for (const watcher of watchers) watcher();
};
/** The agent's turn after the person's: it thinks, then speaks a while. */
const answer = () => {
	set({ progress: "working" });
	setTimeout(() => set({ progress: null, reading: 4 }), 2500);
	setTimeout(() => set({ reading: null }), 7500);
};
const voice = {
	state,
	watch: (changed: () => void) => {
		watchers.add(changed);
		return () => watchers.delete(changed);
	},
	speakerLevel: () =>
		state.reading !== null && !state.hearing && state.speaker ? speech(3) : 0,
	setListener: async (listener: boolean) => set({ listener }),
	setSpeaker: async (speaker: boolean) => set({ speaker }),
	setAutoEnd: async (autoEnd: boolean) => set({ autoEnd, listener: autoEnd }),
	press: async () => set({ listener: true, reading: null }),
	release: () => {
		set({ listener: false });
		answer();
	},
	copyLast: async () => {},
	download: async () => ({ name: "trace.zip", blob: new Blob() }),
	share: (sharing: boolean) => set({ sharing }),
	setLanguages: async (languages: string[]) => set({ languages }),
	setSounds: (sounds: boolean) => set({ sounds }),
	setTier: async (tier: VoiceState["tier"]) => set({ tier }),
	setEngineVoice: (engineVoice: string) => set({ engineVoice }),
} as unknown as Voice;
// The microphone's level, changed in place, as it is read every frame.
setInterval(() => {
	state.level = state.listener ? speech(0) : 0.01;
}, 30);

// The agent, receiving unless it works, and the engine on the local tier.
const room: Room = {
	people: [
		{
			name: "luis/claude",
			receiving: state.progress !== "working",
			engine: false,
		},
		// In the group states, a second agent, in a shade of its own, and
		// another person.
		...(name?.startsWith("group")
			? [
					{ name: "ben/codex", receiving: true, engine: false },
					{ name: "tristan", receiving: true, engine: false },
				]
			: []),
		...(state.engine
			? [{ name: "luis/claude/engine", receiving: true, engine: true }]
			: []),
	],
	// A conversation so far, but in the state named off, before anything was said.
	turns:
		name === "off"
			? []
			: [
					{
						n: 1,
						from: "luis",
						mine: true,
						text: "[voice 1] Can you check why the turn ends too early?",
					},
					{
						n: 2,
						from: "luis/claude",
						mine: false,
						text: "Yes. The pause it waits for is 0.6 seconds, and Smart Turn ends most turns before that.",
					},
					{
						n: 3,
						from: "luis",
						mine: true,
						text: "[voice 1] Okay, and what would you change?",
					},
					{
						n: 4,
						from: "luis/claude",
						mine: false,
						text: "I'd wait longer after an unfinished sentence, and keep the rest as it is. Should I measure it first?",
					},
					{
						n: 5,
						from: "ben/codex",
						mine: false,
						text: "I have the numbers from yesterday, if that helps.",
					},
				],
	speakers: name === "off" ? [] : ["luis/claude", "ben/codex"],
	link: "https://polylogue.agentics.lwirth.com/s/abc123",
	leave: () => {},
};

const root = document.getElementById("root");
// A state named settings opens them, as a press on their button does.
if (name?.startsWith("settings"))
	setTimeout(
		() =>
			document
				.querySelector<HTMLButtonElement>('[aria-label="Settings"]')
				?.click(),
		100,
	);
if (root)
	createRoot(root).render(
		<main className="mx-auto flex h-dvh max-w-2xl flex-col gap-4 px-3 pt-3 pb-6 sm:px-4 sm:pb-8">
			<Call voice={voice} room={room} changeKey={() => {}} />
		</main>,
	);
