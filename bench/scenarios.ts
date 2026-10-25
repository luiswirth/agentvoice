// What the person says in a run, against the thresholds of
// project/voice/experience.md: each turn should reach the agent as one
// message, whatever its pauses, and as soon as it ends.

export type Turn = {
	/** Said one after the other, `pause` seconds apart: a pause mid-thought. */
	parts: string[];
	pause?: number;
	/** Silence after the turn, in seconds. */
	after?: number;
};

export type Scenario = {
	name: string;
	/** Silence before the first turn, in seconds. */
	lead?: number;
	turns: Turn[];
};

export const scenarios: Scenario[] = [
	{
		name: "turns",
		turns: [
			{ parts: ["Can you tell me what the weather is like in Zurich today?"] },
			{
				parts: ["I think we should look at the", "turn detection first."],
				pause: 1,
			},
			{
				parts: ["So the plan is that we", "measure it before we change it."],
				pause: 1.3,
			},
			{ parts: ["Okay, that sounds good."], after: 3 },
			{ parts: ["And then deploy it tonight."] },
		],
	},
	{
		// Short pauses mid-sentence, where words must survive the cut, and a
		// finished sentence the person goes on after.
		name: "pauses",
		turns: [
			{
				parts: [
					"I was wondering whether",
					"we could move the meeting",
					"to Thursday afternoon.",
				],
				pause: 0.5,
			},
			{
				parts: ["The thing is that the", "numbers don't add up yet."],
				pause: 0.8,
			},
			{
				parts: ["Let me think about it.", "Actually, yes, let's do that."],
				pause: 0.6,
			},
			{
				parts: [
					"Send the draft to Benedict",
					"and Stefan",
					"once it compiles.",
				],
				pause: 0.4,
			},
		],
	},
];
