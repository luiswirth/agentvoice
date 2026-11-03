// The reflexes' models in the page: ONNX Runtime Web set up in a worker, and
// each model fetched once, checked against its hash, and kept in the
// browser's cache.
import mjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import * as ort from "onnxruntime-web/wasm";
import type { Model, Port } from "voice-core";

/**
 * Sets up ONNX Runtime in a worker, before its first session. ONNX Runtime
 * builds only with threads, so its memory is shared, and Safari reserves a
 * shared memory's whole maximum up front: the iPhone runs out after a few.
 * ONNX Runtime's maximum of 4 GiB is fixed in its build, so voice carries a
 * patch of its glue (`patches/`) that lowers it to 256 MiB, which it loads
 * rather than the glue in its bundle. Turn detection needs 49 MiB; in it, the
 * fingerprint model embeds up to 15 s at once, as measured in Chromium, and
 * the listener gives it at most 10.
 */
export function setUpOnnxRuntime(): void {
	ort.env.wasm.wasmPaths = { mjs, wasm };
	// One thread, as voice always ran: more were never measured.
	ort.env.wasm.numThreads = 1;
}

const CACHE = "voice-models";

/** A model's bytes, from the browser's cache once fetched. */
export async function fetchModel({
	url,
	integrity,
}: Model): Promise<Uint8Array> {
	const cache = await caches.open(CACHE);
	const cached = await cache.match(url);
	if (cached !== undefined) return new Uint8Array(await cached.arrayBuffer());
	const response = await fetch(url, { integrity });
	if (!response.ok)
		throw new Error(`Fetching ${url} failed: ${response.status}`);
	await cache.put(url, response.clone());
	return new Uint8Array(await response.arrayBuffer());
}

/** A worker's global scope, as far as its channel to the page goes. */
export type Scope = {
	postMessage(message: unknown, transfer: Transferable[]): void;
	onmessage: ((event: MessageEvent) => void) | null;
	close(): void;
};

/** A worker's own end of its channel to the page. */
export function within<Out, In>(scope: Scope): Port<Out, In> {
	return {
		post: (message, transfer = []) => scope.postMessage(message, transfer),
		receive: (message) => {
			scope.onmessage = ({ data }: MessageEvent<In>) => message(data);
		},
		close: () => scope.close(),
	};
}
