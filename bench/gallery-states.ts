// The states bench/gallery-page.tsx shows the voice bar in, by name.
import type { VoiceState } from "../src/voice/voice.ts";

export const base: VoiceState = {
	listener: false,
	speaker: false,
	autoEnd: true,
	recording: false,
	ended: null,
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
	progress: null,
	sounds: true,
	missed: null,
	error: null,
	refused: false,
	tier: "elevenlabs",
	engine: false,
	ready: true,
};

export const states: Record<string, Partial<VoiceState>> = {
	off: {},
	"read-aloud": { speaker: true, reading: 1 },
	transcription: {
		listener: true,
		hearing: "so the plan is that we measure it before we",
	},
	conversation: { listener: true, speaker: true },
	"agent-working": { listener: true, speaker: true, progress: "working" },
	languages: { listener: true, languages: ["en", "de"] },
	"agent-speaking": { listener: true, speaker: true, reading: 1 },
	missed: {
		listener: true,
		speaker: true,
		reading: 1,
		missed: { text: "Yes.", echoed: true },
	},
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
	"manual-idle": { speaker: true, autoEnd: false },
	"manual-recording": {
		listener: true,
		speaker: true,
		autoEnd: false,
		recording: true,
	},
	"manual-speaking": {
		listener: true,
		speaker: true,
		autoEnd: false,
		recording: true,
		draft: "I think we should look at the turn detection first,",
		hearing: "and then deploy it tonight.",
	},
	manual: {
		listener: true,
		speaker: true,
		autoEnd: false,
		draft:
			"I think we should look at the turn detection first, and then deploy it tonight.",
	},
	"manual-sent": {
		listener: true,
		speaker: true,
		autoEnd: false,
		ended: {
			text: "I think we should look at the turn detection first, and then deploy it tonight.",
			sent: true,
		},
	},
	"manual-deleted": {
		listener: true,
		speaker: true,
		autoEnd: false,
		ended: {
			text: "I think we should look at the turn detection first, and then deploy it tonight.",
			sent: false,
		},
	},
};
