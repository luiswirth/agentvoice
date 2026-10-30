import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** As `public/_headers` serves the page. */
const headers = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
	base: "./",
	// The workers import modules.
	worker: { format: "es" },
	server: { headers },
	preview: { headers },
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
