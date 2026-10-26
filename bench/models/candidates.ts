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

function moonshine(language: "de" | "en"): Hearing {
	return {
		kind: "hearing",
		languages: [language],
		async load() {
			const transcriber = await Transcriber.load({
				language,
				modelArch: ModelArch.SmallStreaming,
			});
			return async (pcm) =>
				transcriber
					.transcribe(pcm, { sampleRate: 16_000 })
					.lines.map((line) => line.text)
					.join(" ");
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

function phonon(device: "cpu" | "webgpu"): Speaking {
	return {
		kind: "speaking",
		language: "en",
		async load() {
			const tts = await PhononTTS.load({ lang: "en", device });
			return {
				sampleRate: tts.sampleRate,
				speak: (text) => tts.stream(text),
				info: `${tts.device} (${tts.deviceReason}), ${tts.threads} threads (${tts.threadsReason})`,
			};
		},
	};
}

export const candidates: Record<string, Candidate> = {
	"moonshine-small-en": moonshine("en"),
	"parakeet-webgpu-fp16": parakeet("webgpu"),
	"parakeet-wasm-int8": parakeet("wasm"),
	"phonon-31m-en-cpu": phonon("cpu"),
	"phonon-31m-en-webgpu": phonon("webgpu"),
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
