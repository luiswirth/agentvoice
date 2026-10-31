// The voice bar in one state, named by `?state=`, with a fake voice whose
// levels move as speech would: for looking at the UI without a session.
import { createRoot } from "react-dom/client";
import "../src/index.css";
import type { Voice, VoiceState } from "../src/voice/voice.ts";
import { type Room, VoiceBar } from "../src/voice/voice-bar.tsx";
import { base, states } from "./gallery-states.ts";

const name = new URLSearchParams(location.search).get("state") ?? "off";
const state: VoiceState = { ...base, ...states[name] };
const t0 = performance.now();
/** Speech-like: syllables under a slower swell. */
const speech = (phase: number) => {
	const t = (performance.now() - t0) / 1000 + phase;
	return Math.min(
		1,
		Math.abs(Math.sin(t * 9)) * (0.25 + 0.6 * Math.abs(Math.sin(t * 1.7))),
	);
};
const voice = {
	state,
	watch: () => () => {},
	speakerLevel: () =>
		state.reading !== null && !state.hearing ? speech(3) : 0,
	speakerProgress: () => 0.38,
	setListener: async () => {},
	setSpeaker: async () => {},
	setAutoEnd: () => {},
	send: () => {},
	clear: () => {},
	record: async () => {},
	undo: () => {},
	setDraft: () => {},
	copyLast: async () => {},
	hold: () => {},
	replay: async () => {},
	share: () => {},
	setLanguages: async () => {},
	skip: () => {},
	setSounds: () => {},
	setTier: async () => {},
	setEngineVoice: () => {},
} as unknown as Voice;
// The microphone's level is part of the state, which changes as it moves.
setInterval(() => {
	voice.state = { ...voice.state, level: state.hearing ? speech(0) : 0.01 };
}, 30);

// The agent, receiving unless it works, and the engine on the local tier.
const room: Room = {
	people: [
		{
			name: "luis/claude",
			receiving: state.progress !== "working",
			engine: false,
		},
		// A second agent, in a shade of its own, and another person.
		{ name: "ben/codex", receiving: true, engine: false },
		{ name: "tristan", receiving: true, engine: false },
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
if (name.startsWith("settings"))
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
			<VoiceBar voice={voice} room={room} changeKey={() => {}} />
		</main>,
	);
