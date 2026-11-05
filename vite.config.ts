import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** As lwirth-cloud serves the page, in dotcloud's serve.nix. */
const headers = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

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
	preview: { headers },
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
