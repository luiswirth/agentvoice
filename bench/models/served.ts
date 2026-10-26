// The candidates the page can't load straight from Hugging Face: gated ones,
// which a browser can't fetch without a token, and ones whose files need a
// change before their package loads them. Fetched once here, the gated ones
// with the token in ~/secrets/huggingface-token.txt, and served to the page
// under `models/`.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Model = {
	repository: string;
	/** Each file the page loads, by its name under the model's directory: its
	 * path in the repository, pinned to a revision. */
	files: Record<string, string>;
	gated?: boolean;
	/** Changes a fetched file before it is served. */
	change?: Record<string, (file: Buffer) => Buffer>;
	/** Files the repository lacks, written here. */
	written?: Record<string, unknown>;
	/** Files made from the fetched ones, each by a function of the model's
	 * directory and the file's path. */
	made?: Record<string, (directory: string, path: string) => void>;
};

/** The phonon-tts sources, pinned at 0.4.2, for their tools. */
const XN_PTTS = "37003a71a04012e25d43161b5d8f5c7510a65a78";

/** Each served model by its directory under `models/`. */
export const SERVED: Record<string, Model> = {
	"phonon-40m-de": {
		repository: "gradium/phonon-40m-de",
		gated: true,
		files: Object.fromEntries(
			[
				"config.json",
				"tokenizer.json",
				"model.q8.gguf",
				"default-voice.safetensors",
			].map((file) => [
				file,
				`79cfc7b47fcfc0b666657b981eb366415023a862/${file}`,
			]),
		),
	},
	// Kyutai's German model, in the repository without voice cloning, which is
	// not gated. Its revisions are the ones pocket-tts's german.yaml pins.
	"pocket-tts-de": {
		repository: "kyutai/pocket-tts-without-voice-cloning",
		files: {
			"model.safetensors":
				"1e08e6a23401048648a9fdcfde2f89348215c2a7/languages/german/model.safetensors",
			"tokenizer.json":
				"4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/german/tokenizer.json",
			"alba.safetensors":
				"1e08e6a23401048648a9fdcfde2f89348215c2a7/languages/german/embeddings/alba.safetensors",
		},
		// phonon-tts sizes the speaker projection by the codec's 512 wide
		// latents, where this model projects the quantizer's 32. Both tensors
		// only serve cloning a voice from audio: the voices here are already the
		// model's state after the voice, the token before it included.
		change: {
			"model.safetensors": (file) =>
				without(file, [
					"flow_lm.speaker_proj_weight",
					"flow_lm.bos_before_voice",
				]),
		},
		// The config of Pocket TTS's English model, as phonon-tts's tests have it
		// (ptts/tests/fixtures/config.json in gradium-ai/xn-ptts), which
		// pocket-tts's german.yaml matches in every dimension.
		written: {
			"config.json": {
				languages: ["de"],
				flow_lm: {
					d_model: 1024,
					num_heads: 16,
					num_layers: 6,
					dim_feedforward: 4096,
					max_period: 10000.0,
					n_bins: 4000,
					lut_dim: 1024,
					flow_dim: 512,
					flow_depth: 6,
					ldim: 32,
				},
				mimi: {
					channels: 1,
					sample_rate: 24000,
					frame_rate: 12.5,
					dimension: 512,
					quantizer_dimension: 32,
					quantizer_output_dimension: 512,
					n_filters: 64,
					n_residual_layers: 1,
					ratios: [6, 5, 4],
					kernel_size: 7,
					last_kernel_size: 3,
					residual_kernel_size: 3,
					dilation_base: 2,
					compress: 2,
					transformer_d_model: 512,
					transformer_num_heads: 8,
					transformer_num_layers: 2,
					transformer_layer_scale: 0.01,
					transformer_context: 250,
					transformer_max_period: 10000.0,
					transformer_dim_feedforward: 2048,
					downsample_channel_wise: false,
				},
				lsd_decode_steps: 1,
				eos_threshold: -4.0,
				model_id: null,
				audio_prompt_min_duration: 10.0,
				audio_prompt_max_duration: 10.0,
				cfg_null_audio_empty: false,
				speaker_mimi: null,
				conditioners: [],
				fuser: null,
				voices: [],
			},
		},
		// WebGPU only takes q8 weights, which Kyutai doesn't publish: made with
		// phonon-tts's own tool, as Phonon's q8 files are, without the speaker
		// encoder, which the voices here don't need.
		made: {
			"model.q8.gguf": (directory, path) =>
				quantize(join(directory, "model.safetensors"), path),
		},
	},
};

/** Moonshine Small Streaming German, which moonshine-wasm's catalog lacks:
 * Moonshine's checkpoint for Transformers (MIT), made into the files the
 * package loads by `moonshine-export.sh`, all at once. */
SERVED["moonshine-small-de"] = {
	repository: "moonshine-ai/moonshine-streaming-small-de",
	files: {},
	made: {
		"encoder.ort": (directory) =>
			execFileSync(
				join(import.meta.dirname, "moonshine-export.sh"),
				[
					resolve(directory, "../../moonshine"),
					"moonshine-ai/moonshine-streaming-small-de",
					"56473ba32b22b484fdfc7eb03d34c393ff494197",
					resolve(directory),
				],
				{ stdio: ["ignore", "ignore", "inherit"] },
			),
	},
};

/** Quantizes safetensors weights to q8 GGUF with phonon-tts's `quantize`. */
function quantize(input: string, output: string) {
	const sources = resolve(dirname(output), "../../xn-ptts");
	execFileSync(
		"sh",
		[
			"-c",
			`test -d "$1" || git clone -q https://github.com/gradium-ai/xn-ptts "$1"
			cd "$1" && git checkout -q ${XN_PTTS} &&
			nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#gcc -c cargo run -q --release \
				-p ptts --example quantize -- "$2" "$3" --quant q8_0 --no-mimi-encoder`,
			"quantize",
			sources,
			resolve(input),
			resolve(output),
		],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
}

/** Fetches the served models into `directory`, those not there yet. */
export async function served(directory: string) {
	let token: string | undefined;
	for (const [name, model] of Object.entries(SERVED)) {
		for (const [file, json] of Object.entries(model.written ?? {})) {
			await mkdir(join(directory, name), { recursive: true });
			await writeFile(join(directory, name, file), JSON.stringify(json));
		}
		for (const [file, source] of Object.entries(model.files)) {
			const path = join(directory, name, file);
			if (await stat(path).catch(() => undefined)) continue;
			if (model.gated)
				token ??= (
					await readFile(
						join(homedir(), "secrets/huggingface-token.txt"),
						"utf8",
					)
				).trim();
			const url = `https://huggingface.co/${model.repository}/resolve/${source}`;
			const response = await fetch(url, {
				headers: model.gated ? { Authorization: `Bearer ${token}` } : {},
			});
			if (!response.ok) throw new Error(`${url}: ${response.status}`);
			const fetched = Buffer.from(await response.arrayBuffer());
			const change = model.change?.[file] ?? ((file: Buffer) => file);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, change(fetched));
		}
		for (const [file, make] of Object.entries(model.made ?? {})) {
			const path = join(directory, name, file);
			if (!(await stat(path).catch(() => undefined)))
				make(join(directory, name), path);
		}
	}
}

/** A safetensors file without the named tensors, the others packed again
 * with no gap, as the format requires. */
function without(file: Buffer, names: string[]): Buffer {
	const size = Number(file.readBigUInt64LE(0));
	const header = JSON.parse(file.subarray(8, 8 + size).toString()) as Record<
		string,
		{ data_offsets: [number, number] }
	>;
	const data = file.subarray(8 + size);
	const kept: Record<string, unknown> = {};
	const parts: Buffer[] = [];
	let at = 0;
	const tensors = Object.entries(header)
		.filter(([name]) => name !== "__metadata__" && !names.includes(name))
		.sort(([, a], [, b]) => a.data_offsets[0] - b.data_offsets[0]);
	if ("__metadata__" in header) kept.__metadata__ = header.__metadata__;
	for (const [name, tensor] of tensors) {
		const [start, end] = tensor.data_offsets;
		parts.push(data.subarray(start, end));
		kept[name] = { ...tensor, data_offsets: [at, at + end - start] };
		at += end - start;
	}
	// The header is padded with spaces to a multiple of 8, as writers do.
	let json = JSON.stringify(kept);
	json += " ".repeat((8 - (json.length % 8)) % 8);
	const length = Buffer.alloc(8);
	length.writeBigUInt64LE(BigInt(Buffer.byteLength(json)));
	return Buffer.concat([length, Buffer.from(json), ...parts]);
}
