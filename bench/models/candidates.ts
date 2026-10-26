// The candidate models of fully local voice, each run through the package its
// makers publish for the browser, as they ship it.
import { ModelArch, Transcriber } from "@moonshine-ai/moonshine-wasm";
import { fromHub } from "parakeet.js";
import { PhononTTS } from "phonon-tts";

export type Hearing = {
	kind: "hearing";
	/** The languages of the clips it hears. */
	languages: ("de" | "en")[];
	load(): Promise<(pcm: Float32Array) => Promise<string>>;
};

export type Speaking = {
	kind: "speaking";
	language: "de" | "en";
	load(): Promise<{
		sampleRate: number;
		/** Speaks the text, as chunks of audio as they are generated. */
		speak(text: string): AsyncIterable<Float32Array>;
		/** Where it runs, as its package reports it. */
		info?: string;
	}>;
};

export type Candidate = Hearing | Speaking;

let beat = 0;
/** Logs a package's progress every few seconds, to see where a load hangs. */
function heartbeat(line: string) {
	if (performance.now() - beat < 5000) return;
	beat = performance.now();
	console.info(line);
	void fetch("./log", { method: "POST", body: line.slice(0, 300) });
}

/** Moonshine Small Streaming German, which the package's catalog lacks: made
 * by the bench from its Hugging Face checkpoint with Moonshine's own export, in
 * `served.ts`. */
const MOONSHINE_SMALL_DE = Object.fromEntries(
	[
		"frontend.ort",
		"encoder.ort",
		"adapter.ort",
		"cross_kv.ort",
		"decoder_kv.ort",
		"streaming_config.json",
		"tokenizer.bin",
	].map((file) => [file, `./models/moonshine-small-de/${file}`]),
);

/** How Moonshine hears a clip: as the package does by default, in lines cut
 * at the pauses its voice detection finds, or whole, without it, as one line
 * of up to 30 s. Whole, a second of silence follows the clip, without which
 * the clip's last word is lost. */
type Cutting = "lines" | "whole";

function moonshine(
	language: "de" | "en",
	cutting: Cutting,
	files?: Record<string, string>,
): Hearing {
	return {
		kind: "hearing",
		languages: [language],
		async load() {
			const modelArch = ModelArch.SmallStreaming;
			const options: Record<string, string> =
				cutting === "whole"
					? { vad_threshold: "0", vad_max_segment_duration: "30" }
					: {};
			const transcriber =
				files === undefined
					? await Transcriber.load({ language, modelArch, options })
					: await Transcriber.loadFromUrls(files, { modelArch, options });
			const silence = new Float32Array(cutting === "whole" ? 16_000 : 0);
			return async (pcm) => {
				const padded = new Float32Array(pcm.length + silence.length);
				padded.set(pcm);
				return transcriber
					.transcribe(padded, { sampleRate: 16_000 })
					.lines.map((line) => line.text)
					.join(" ");
			};
		},
	};
}

function parakeet(backend: "webgpu" | "wasm"): Hearing {
	return {
		kind: "hearing",
		languages: ["de", "en"],
		async load() {
			const model = await fromHub("parakeet-tdt-0.6b-v3", {
				backend,
				encoderQuant: backend === "webgpu" ? "fp16" : "int8",
				decoderQuant: "int8",
				progress: (progress: unknown) => heartbeat(JSON.stringify(progress)),
			});
			return async (pcm) =>
				(await model.transcribe(pcm, 16_000)).utterance_text;
		},
	};
}

/** Phonon 40m German, gated, so served by the bench from `served.ts`. */
const PHONON_40M_DE = {
	weights: { q8: "./models/phonon-40m-de/model.q8.gguf" },
	tokenizer: "./models/phonon-40m-de/tokenizer.json",
	config: "./models/phonon-40m-de/config.json",
	voices: { default: "./models/phonon-40m-de/default-voice.safetensors" },
	defaultVoice: "default",
};

/** Pocket TTS German, which phonon-tts runs, served by the bench from
 * `served.ts`: Kyutai's bf16 weights, and q8 made from them there. */
const POCKET_TTS_DE = {
	weights: {
		f32: "./models/pocket-tts-de/model.safetensors",
		q8: "./models/pocket-tts-de/model.q8.gguf",
	},
	tokenizer: "./models/pocket-tts-de/tokenizer.json",
	config: "./models/pocket-tts-de/config.json",
	voices: { alba: "./models/pocket-tts-de/alba.safetensors" },
	defaultVoice: "alba",
};

function phonon(
	language: "de" | "en",
	device: "cpu" | "webgpu",
	model?: typeof PHONON_40M_DE | typeof POCKET_TTS_DE,
	quant: "q8" | "f32" = "q8",
): Speaking {
	return {
		kind: "speaking",
		language,
		async load() {
			const tts = await PhononTTS.load({
				lang: language,
				device,
				...(model === undefined ? {} : { model }),
				quant,
			});
			return {
				sampleRate: tts.sampleRate,
				speak: (text) => tts.stream(text),
				info: `${tts.device} (${tts.deviceReason}), ${tts.threads} threads (${tts.threadsReason})`,
			};
		},
	};
}

export const candidates: Record<string, Candidate> = {
	"moonshine-small-en": moonshine("en", "lines"),
	"moonshine-small-en-whole": moonshine("en", "whole"),
	"moonshine-small-de": moonshine("de", "lines", MOONSHINE_SMALL_DE),
	"moonshine-small-de-whole": moonshine("de", "whole", MOONSHINE_SMALL_DE),
	"parakeet-webgpu-fp16": parakeet("webgpu"),
	"parakeet-wasm-int8": parakeet("wasm"),
	"phonon-31m-en-cpu": phonon("en", "cpu"),
	"phonon-31m-en-webgpu": phonon("en", "webgpu"),
	"phonon-40m-de-cpu": phonon("de", "cpu", PHONON_40M_DE),
	"phonon-40m-de-webgpu": phonon("de", "webgpu", PHONON_40M_DE),
	"pocket-tts-de-cpu": phonon("de", "cpu", POCKET_TTS_DE),
	"pocket-tts-de-cpu-f32": phonon("de", "cpu", POCKET_TTS_DE, "f32"),
	"pocket-tts-de-webgpu": phonon("de", "webgpu", POCKET_TTS_DE),
};

/** What the speaking candidates say: short and long, as an agent's replies are. */
export const sentences = {
	en: [
		"Okay.",
		"Sure, I'll look into that right away.",
		"The build failed because the lock file is out of date, so I updated it and ran the checks again.",
	],
	de: [
		"Okay.",
		"Klar, das schaue ich mir gleich an.",
		"Der Build ist fehlgeschlagen, weil die Lock-Datei veraltet war, also habe ich sie aktualisiert und die Checks nochmals laufen lassen.",
	],
};
