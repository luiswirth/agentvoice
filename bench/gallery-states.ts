// The states bench/gallery-page.tsx shows the voice bar in, by name.
import type { VoiceState } from "../src/voice/voice.ts";

export const base: VoiceState = {
	listener: false,
	speaker: false,
	autoEnd: true,
	switching: null,
	hearing: "",
	draft: "",
	level: 0,
	reading: null,
	held: false,
	message: null,
	last: "Earlier words.",
	languages: [],
	sharing: false,
	names: {},
	error: null,
	refused: false,
};

export const states: Record<string, Partial<VoiceState>> = {
	off: {},
	"read-aloud": { speaker: true, reading: 1 },
	transcription: {
		listener: true,
		hearing: "so the plan is that we measure it before we",
	},
	conversation: { listener: true, speaker: true },
	languages: { listener: true, languages: ["en", "de"] },
	"agent-speaking": { listener: true, speaker: true, reading: 1 },
	named: {
		listener: true,
		speaker: true,
		names: { "1": "Luis" },
		voice: 1,
		hearing: "so the plan is that we measure it before we",
	},
	unnamed: {
		listener: true,
		speaker: true,
		reading: 1,
		names: { "1": "Luis" },
		voice: 2,
		hearing: "and in other news today",
	},
	"you-speaking": {
		listener: true,
		speaker: true,
		draft: "I think we should look at the turn detection first.",
		hearing: "And then deploy it",
	},
	manual: {
		listener: true,
		speaker: true,
		autoEnd: false,
		draft:
			"I think we should look at the turn detection first, and then deploy it tonight.",
	},
};
