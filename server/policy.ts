/** The headers the page is served with, by the server and by `vite preview`
 * alike: cross-origin isolation, which the models' threads need, and the
 * policy of what the page may load and reach: its own scripts and
 * WebAssembly, its server, ElevenLabs, and the models of
 * voice/src/models.ts, whose Hugging Face links redirect to its storage. */

const policy = [
	"default-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"media-src 'self' data: blob:",
	"worker-src 'self' blob:",
	"connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io https://raw.githubusercontent.com https://huggingface.co https://*.huggingface.co https://*.hf.co",
	"object-src 'none'",
	"base-uri 'none'",
	"frame-ancestors 'none'",
].join("; ");

export const isolation = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

export const headers = {
	...isolation,
	"Content-Security-Policy": policy,
};
