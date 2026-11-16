import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** As lwirth-cloud serves the page, in dotcloud's serve.nix. */
const headers = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

/** What the page may load and reach, as lwirth-cloud serves it, in dotcloud's
 * serve.nix: its own scripts and WebAssembly, Vibe Together, ElevenLabs, and
 * the models of voice/src/models.ts, whose Hugging Face links redirect to its
 * storage. */
const policy = [
	"default-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"media-src 'self' data: blob:",
	"worker-src 'self' blob:",
	"connect-src 'self' https://vibetogether.potentialhedge.com https://api.elevenlabs.io wss://api.elevenlabs.io https://raw.githubusercontent.com https://huggingface.co https://*.huggingface.co https://*.hf.co",
	"object-src 'none'",
	"base-uri 'none'",
	"frame-ancestors 'none'",
].join("; ");

export default defineConfig({
	base: "./",
	// The workers import modules.
	worker: { format: "es" },
	// The page, and the call without a session at /demo.
	build: {
		rollupOptions: {
			input: {
				main: fileURLToPath(new URL("./index.html", import.meta.url)),
				demo: fileURLToPath(new URL("./demo/index.html", import.meta.url)),
			},
		},
	},
	server: { headers },
	// The built page runs under the policy it is served with.
	preview: {
		headers: { ...headers, "Content-Security-Policy": policy },
	},
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
