// A conversation to record as ground truth: what the person reads from the
// prompter, and what the agent says, so that both sides are known by
// construction. `just record` plays the agent's side into a real voice
// session while the person reads theirs.
//
// It covers the thresholds of project/voice/experience.md: turn ends and
// pauses mid-thought, short turns, turns that follow each other closely, the
// agent's echo, backchannels, coughs and cutting in, and words a transcriber
// gets wrong, such as names, numbers and technical terms.

/** What the person does while the agent speaks, `at` seconds after its line
 * was sent: say words, as a backchannel or to cut in, or cough. */
export type Cue = { at: number } & (
	| { say: string; kind: "backchannel" | "cut-in" }
	| { cough: true }
);

export type Step =
	/** A turn of the person, its parts said with a pause of `pauses[i]`
	 * seconds after part `i`: a pause mid-thought. The agent answers
	 * `reply`, if any, once the turn is said. */
	| { turn: string[]; pauses?: number[]; reply?: string; note?: string }
	/** The agent speaks, and the person follows the cues while it does. */
	| { agent: string; cues?: Cue[]; note?: string }
	/** The person stays quiet, or coughs once at its start. */
	| { silence: number; cough?: true; note?: string };

export const conversation: Step[] = [
	{ silence: 3, note: "Stay quiet: the room alone." },
	{ turn: ["Hi, can you hear me okay?"], reply: "Yes, I hear you fine." },
	{
		turn: ["Good. Today I want to go through the voice bench with you."],
		reply: "Sure, go ahead.",
	},
	// Pauses mid-thought, where the words so far are unfinished.
	{
		turn: ["I think the main problem is", "that it cuts me off when I pause."],
		pauses: [1.5],
		reply: "Got it.",
	},
	{
		turn: [
			"We tried Parakeet v2 and Kokoro,",
			"both through sherpa-onnx,",
			"and they run fine on the server.",
		],
		pauses: [0.8, 1.2],
		reply: "Good to know.",
	},
	{
		turn: [
			"So the question is whether we",
			"um,",
			"whether we keep ElevenLabs at all.",
		],
		pauses: [2.5, 1],
		reply: "Let's measure it first.",
	},
	{
		turn: ["And then there is one more thing, and", "it's about the latency."],
		pauses: [4],
		note: "A long pause mid-thought: hold it.",
		reply: "Okay, the latency.",
	},
	// Names, numbers and technical terms.
	{
		turn: [
			"The relay listens on port 8443, behind Tailscale, on the NixOS server.",
		],
		reply: "Okay.",
	},
	{
		turn: [
			"The deadline is the twelfth of November, and the draft has twenty-four pages.",
		],
		reply: "Noted.",
	},
	{
		turn: [
			"Send the draft to Benedict and Tristan once formoniq compiles with Rust 1.91.",
		],
		reply: "I'll send it then.",
	},
	// Short turns, which must not be taken for noise.
	{ agent: "Should I run the bench now?" },
	{ turn: ["Yes."] },
	{ agent: "On the Mac or on the server?" },
	{ turn: ["On the server."] },
	{ agent: "With the new recording?" },
	{ turn: ["Exactly."], reply: "Starting it." },
	// Turns that follow each other closely stay two turns.
	{ turn: ["That's all for the listener."] },
	{ silence: 3 },
	{
		turn: ["Now let's talk about the speaker."],
		reply: "Sure, what about it?",
	},
	// The agent's voice alone, for its echo.
	{
		agent:
			"The speaker reads each message sentence by sentence. The first sentence is short, so that the first audio comes early. While it reads, the listener keeps listening, and what it hears of the speaker's own voice is echo, which never takes the floor.",
		note: "Stay quiet and listen.",
	},
	{ silence: 2 },
	// Backchannels and a cough while the agent speaks, which leave its turn
	// running.
	{
		agent:
			"So here is the plan. First we record a few conversations like this one, on the Mac, the iPhone and with AirPods. Then the bench replays them, and scores each turn against what was really said. And then we tune the turn detection until nothing gets cut off.",
		cues: [
			{ at: 4, say: "Mhm.", kind: "backchannel" },
			{ at: 8, say: "Yeah.", kind: "backchannel" },
			{ at: 12, cough: true },
			{ at: 15, say: "Okay.", kind: "backchannel" },
		],
	},
	{ silence: 3, cough: true, note: "Cough once, then stay quiet." },
	// Cutting in, the cut-in being a turn of its own.
	{
		agent:
			"Next I would look at the stretches. Each stretch gets a voice fingerprint and a transcript, and diarization tells the voices apart, so that the agent's own voice is never taken for the person's, and a cough in the room is not either.",
		cues: [
			{
				at: 5,
				say: "Wait, wait, stop for a second. I meant the other branch, not main.",
				kind: "cut-in",
			},
		],
	},
	{ silence: 2 },
	{
		agent:
			"Ah, the other branch. Then I would merge it first, run the checks, and deploy it once they pass, which takes about two minutes.",
		cues: [{ at: 3, say: "No.", kind: "cut-in" }],
	},
	{ turn: ["That's not what I asked."], reply: "Sorry. What did you mean?" },
	{
		turn: ["Just run the bench on the branch,", "and tell me the numbers."],
		pauses: [1],
		reply: "Will do.",
	},
	{ turn: ["Okay, that's it. Thanks."], reply: "Thanks, bye." },
	{ silence: 3 },
];
