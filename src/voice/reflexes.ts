// Where the core's reflexes run in the page: each in a worker of its own.
import type { Port, Reflexes } from "voice-core";
import FingerprintsWorker from "./fingerprints-worker.ts?worker";
import TurnsWorker from "./turns-worker.ts?worker";

/** The page's end of a channel to a worker. */
function port<Out, In>(worker: Worker): Port<Out, In> {
	return {
		post: (message, transfer = []) => worker.postMessage(message, transfer),
		receive: (message, failed) => {
			worker.onmessage = ({ data }: MessageEvent<In>) => message(data);
			worker.onerror = (event) => failed?.(new Error(event.message));
		},
		close: () => worker.terminate(),
	};
}

export const reflexes: Reflexes = {
	turns: () => port(new TurnsWorker()),
	fingerprints: () => {
		const worker = new FingerprintsWorker();
		worker.postMessage(document.baseURI);
		return port(worker);
	},
};
