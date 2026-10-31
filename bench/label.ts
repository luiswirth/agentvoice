// Labels a recording of `just record` with when each line of the
// conversation was said, into `labels.json` beside it: the text comes from
// bench/conversation.ts, the times from Scribe's words, matched to the text.
// Where Scribe heard other words than the script's, the label keeps both, so
// that a line the person misread can be told from a word Scribe got wrong.
// A free answer, which has no script, is the words Scribe heard between the
// prompter showing the question and the person's tap.
//
//   just label <recording directory>
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agent } from "../src/voice/protocol.ts";
import { scripts } from "./conversation.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: label.ts <recording directory>");

const session = JSON.parse(
	await readFile(join(dir, "session.json"), "utf8"),
) as {
	script?: keyof typeof scripts;
	audioStart: string;
	messages: { from: string; time: string; type: string; text?: string }[];
	prompter: { time: string; event: string; step?: number }[];
};
const conversation = scripts[session.script ?? "conversation"];
const t0 = Date.parse(session.audioStart);
/** When the prompter did `event` for `step`, on the recording's clock. */
const at = (event: string, step: number) => {
	const e = session.prompter.find((p) => p.event === event && p.step === step);
	return e ? (Date.parse(e.time) - t0) / 1000 : null;
};

type Word = { text: string; start: number; end: number; type: string };

/** Scribe's words for the recording, kept beside it once fetched. */
async function scribe(): Promise<Word[]> {
	const kept = join(dir ?? ".", "scribe.json");
	const cached = await readFile(kept, "utf8").catch(() => null);
	if (cached) return JSON.parse(cached).words;
	const key = (
		await readFile(join(homedir(), "secrets/elevenlabs-api-key.txt"), "utf8")
	).trim();
	const form = new FormData();
	form.set("model_id", "scribe_v1");
	form.set("language_code", "en");
	form.set("timestamps_granularity", "word");
	form.set("tag_audio_events", "true");
	form.set(
		"file",
		new Blob([await readFile(join(dir ?? ".", "audio.wav"))]),
		"audio.wav",
	);
	const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
		method: "POST",
		headers: { "xi-api-key": key },
		body: form,
	});
	if (!response.ok) throw new Error(`Scribe ${response.status}`);
	const text = await response.text();
	await writeFile(kept, text);
	return JSON.parse(text).words;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, "");
const tokens = (s: string) => s.split(/\s+/).map(norm).filter(Boolean);

/** What the person was to say, in order: each part of a turn, and each
 * backchannel or cut-in while the agent spoke. */
type Line = {
	step: number;
	part: number;
	kind: "part" | "backchannel" | "cut-in" | "free";
	text: string;
};
const lines: Line[] = [];
for (const [step, s] of conversation.entries()) {
	if ("turn" in s)
		for (const [part, text] of s.turn.entries())
			lines.push({ step, part, kind: "part", text });
	if ("agent" in s)
		for (const [part, cue] of (s.cues ?? []).entries())
			if ("say" in cue)
				lines.push({ step, part, kind: cue.kind, text: cue.say });
}
const script = lines.flatMap((line, i) =>
	tokens(line.text).map((token) => ({ token, line: i })),
);

const all = await scribe();
// Scribe sometimes starts a word after a silence at the silence's start, such
// as a "Hi" of 13 s: no word lasts more than a second.
const words = all
	.filter((w) => w.type === "word" && norm(w.text))
	.map((w) => ({ ...w, start: Math.max(w.start, w.end - 1) }));

// The free answers, from the prompter's times; the tap comes after the last
// word, and the recorder hears of it a little later.
const free = conversation.flatMap((s, step) => {
	if (!("ask" in s)) return [];
	const from = at("think", step);
	const to = at("turn.said", step);
	if (from === null || to === null) return [];
	const mine = words.filter((w) => w.start >= from && w.end <= to + 0.5);
	return [{ step, from, to, words: mine }];
});
const heard = words.filter((w) => !free.some((f) => f.words.includes(w)));

// The alignment of the script's words to Scribe's, by least edits.
const n = script.length;
const m = heard.length;
const scriptTokens = script.map((s) => s.token);
const heardTokens = heard.map((w) => norm(w.text));
const same = (i: number, j: number) =>
	scriptTokens[i - 1] === heardTokens[j - 1];
/** The least edits from the script's first `i` words to Scribe's first `j`. */
const cost = new Int32Array((n + 1) * (m + 1));
const edits = (i: number, j: number) => cost[i * (m + 1) + j] ?? 0;
for (let i = 0; i <= n; i++)
	for (let j = 0; j <= m; j++)
		cost[i * (m + 1) + j] =
			i === 0 || j === 0
				? i + j
				: Math.min(
						edits(i - 1, j - 1) + (same(i, j) ? 0 : 1),
						edits(i - 1, j) + 1,
						edits(i, j - 1) + 1,
					);
/** For each of Scribe's words, the line it belongs to, if any. */
const lineOf = new Array<number | undefined>(m);
const matched = new Array<boolean>(m).fill(false);
for (let i = n, j = m; i > 0 || j > 0; ) {
	const here = edits(i, j);
	if (i > 0 && j > 0 && here === edits(i - 1, j - 1) + (same(i, j) ? 0 : 1)) {
		lineOf[j - 1] = script[i - 1]?.line;
		matched[j - 1] = same(i, j);
		i--;
		j--;
		continue;
	}
	if (i > 0 && here === edits(i - 1, j) + 1) i--;
	else j--;
}

// A word Scribe heard inside a line, which the script lacks, belongs to it.
for (let j = 0, last: number | undefined; j < m; j++) {
	if (lineOf[j] !== undefined) {
		last = lineOf[j];
		continue;
	}
	const next = lineOf.slice(j).find((l) => l !== undefined);
	if (last !== undefined && next === last) lineOf[j] = last;
}

const scripted = lines.map((line, i) => {
	const words = heard.filter((_, j) => lineOf[j] === i);
	const hits = heard.filter((_, j) => lineOf[j] === i && matched[j]);
	const first = words[0];
	const last = words.at(-1);
	return {
		...line,
		start: first?.start ?? null,
		end: last?.end ?? null,
		scribe: words.map((w) => w.text).join(" "),
		/** The share of the script's words Scribe heard as they are. */
		match: hits.length / tokens(line.text).length,
	};
});

const said = [
	...scripted,
	...free.map((f) => ({
		step: f.step,
		part: 0,
		kind: "free" as const,
		text: f.words.map((w) => w.text).join(" "),
		start: f.words[0]?.start ?? null,
		end: f.words.at(-1)?.end ?? null,
		scribe: f.words.map((w) => w.text).join(" "),
		match: 1,
		/** The gaps between words of 1 s or more: the pauses of thinking. */
		gaps: f.words
			.slice(1)
			.map((w, i) => +(w.start - (f.words[i]?.end ?? w.start)).toFixed(2))
			.filter((g) => g >= 1),
	})),
].sort((a, b) => a.step - b.step);

// The turns the agent should get, each a message: the parts of a turn
// together, a free answer, and a cut-in on its own.
const turns = conversation.flatMap((_, step) => {
	const mine = said.filter((l) => l.step === step && l.kind !== "backchannel");
	if (mine.length === 0) return [];
	return [
		{
			step,
			text: mine.map((l) => l.text).join(" "),
			start: mine[0]?.start ?? null,
			end: mine.at(-1)?.end ?? null,
			/** The pauses mid-thought, in seconds, as said. */
			pauses: mine
				.slice(1)
				.map((l, i) =>
					l.start !== null && mine[i]?.end != null
						? +(l.start - (mine[i]?.end ?? 0)).toFixed(2)
						: null,
				),
		},
	];
});

// The agent's lines, told by the form of its name, at when they were sent, on
// the recording's clock.
const answers = session.messages
	.filter((e) => agent(e.from) && e.type.startsWith("text/plain"))
	.map((e) => ({ text: e.text, sent: (Date.parse(e.time) - t0) / 1000 }));
const events = all
	.filter((w) => w.type === "audio_event")
	.map((w) => ({ text: w.text, start: w.start, end: w.end }));

await writeFile(
	join(dir, "labels.json"),
	JSON.stringify({ turns, said, agent: answers, events }, null, 1),
);
for (const l of said)
	console.log(
		`${l.start?.toFixed(2) ?? "    -"}–${l.end?.toFixed(2) ?? "-"} ${l.kind} ${(100 * l.match).toFixed(0)}% "${l.text}"${l.match < 1 ? ` / heard "${l.scribe}"` : ""}`,
	);
