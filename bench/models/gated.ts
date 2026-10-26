// The candidates gated on Hugging Face, which a browser can't fetch without
// a token: fetched once here, with the token in
// ~/secrets/huggingface-token.txt, and served to the page under `models/`.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Each gated model by its directory under `models/`: its repository, pinned,
 * and the files the page loads. */
export const GATED = {
	"phonon-40m-de": {
		repository: "gradium/phonon-40m-de",
		revision: "79cfc7b47fcfc0b666657b981eb366415023a862",
		files: [
			"config.json",
			"tokenizer.json",
			"model.q8.gguf",
			"default-voice.safetensors",
		],
	},
};

/** Fetches the gated models into `directory`, those not there yet. */
export async function gated(directory: string) {
	let token: string | undefined;
	for (const [name, model] of Object.entries(GATED))
		for (const file of model.files) {
			const path = join(directory, name, file);
			if (await stat(path).catch(() => undefined)) continue;
			token ??= (
				await readFile(join(homedir(), "secrets/huggingface-token.txt"), "utf8")
			).trim();
			const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${file}`;
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) throw new Error(`${url}: ${response.status}`);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, Buffer.from(await response.arrayBuffer()));
		}
}
