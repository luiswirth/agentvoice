// The voice bar in one state, named by `?state=`, with a fake voice whose
// levels move as speech would: for looking at the UI without a session.
import { createRoot } from "react-dom/client";
import "../src/index.css";
import type { Voice, VoiceState } from "../src/voice/voice.ts";
import { VoiceBar } from "../src/voice/voice-bar.tsx";
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
	setListener: async () => {},
	setSpeaker: async () => {},
	setAutoEnd: () => {},
	send: () => {},
	clear: () => {},
	setDraft: () => {},
	copyLast: async () => {},
	hold: () => {},
	replay: async () => {},
	share: () => {},
	skip: () => {},
} as unknown as Voice;
// The microphone's level is part of the state, which changes as it moves.
setInterval(() => {
	voice.state = { ...voice.state, level: state.hearing ? speech(0) : 0.01 };
}, 30);

const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		<main className="mx-auto flex h-dvh max-w-2xl flex-col gap-4 p-4 pb-8">
			<div className="h-8" />
			<VoiceBar voice={voice} />
		</main>,
	);
