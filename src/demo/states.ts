// The states the demo can start in, by name, which the bench's gallery shows.
import type { VoiceState } from "../voice/voice.ts";

export const base: VoiceState = {
	listener: false,
	speaker: false,
	switching: null,
	hearing: "",
	level: 0,
	reading: null,
	held: false,
	languages: [],
	names: {},
	progress: null,
	sounds: true,
	missed: null,
	error: null,
	refused: false,
	ready: true,
	blocked: false,
};

export const states: Record<string, Partial<VoiceState>> = {
	off: {},
	"read-aloud": { speaker: true, reading: 4 },
	transcription: {
		listener: true,
		hearing: "so the plan is that we measure it before we",
	},
	conversation: { listener: true, speaker: true },
	"agent-working": { listener: true, speaker: true, progress: "working" },
	blocked: { speaker: true, reading: 4, blocked: true },
	languages: { listener: true, languages: ["en", "de"] },
	"agent-speaking": { listener: true, speaker: true, reading: 4 },
	"group-agent-speaking": { listener: true, speaker: true, reading: 4 },
	// The second agent read, in its own shade, its wave too.
	"group-second-agent-speaking": { listener: true, speaker: true, reading: 5 },

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
		reading: 4,
		names: { "1": "Luis" },
		voice: 2,
		hearing: "and in other news today",
	},
	"you-speaking": {
		listener: true,
		speaker: true,
		hearing: "And then deploy it",
	},

	"agent-sent": { listener: true, speaker: true, progress: "sent" },
	settings: {
		listener: true,
		speaker: true,
		languages: ["en", "de"],
		sounds: false,
	},
};
