# Everything CI runs.
ci: client
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm exec tsc -p .
    pnpm exec tsc -p voice
    pnpm build

# Vibe Together's client library as WebAssembly, with its bindings, which the
# page imports from src/vt: from the checkout of PotentialHedge/vibetogether at
# `vt`, as its website builds it.
client vt="../vibetogether":
    cd {{ vt }} && direnv exec . cargo build --release --target wasm32-unknown-unknown -p vibetogether-client
    cd {{ vt }} && direnv exec . wasm-bindgen --target web --out-dir {{ justfile_directory() }}/src/vt target/wasm32-unknown-unknown/release/vibetogether_client.wasm

# The page to try voice on, at localhost:5173.
dev:
    pnpm dev

# Plays a scenario of bench/scenarios.ts, or a recording's WAV, into the page
# built from here, in a session of Vibe Together with a scripted agent, and
# measures how its turns reached it.
bench scenario="turns":
    pnpm build
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/bench.ts {{ scenario }}

# Signs the bench in to Vibe Together as the person, through the page's own
# sign-in: prints the link to approve.
token:
    pnpm build
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/token.ts

# Builds the page and serves it at agentvoice.lwirth.com, from lwirth-cloud,
# whose serve.nix in dotcloud says how.
deploy: ci
    rsync -rlpt --delete --delay-updates --chmod=D755,F644 dist/ root@lwirth-cloud:/srv/voice/

# Screenshots of the call in each state of src/demo/states.ts, on a
# Mac's window and an iPhone's, into bench/.cache/gallery/.
gallery:
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/gallery.ts

# The page's cues as one WAV to listen to, into bench/.cache/sounds.wav.
sounds:
    pnpm exec tsx bench/sounds.ts

# How smoothly the page runs in a gallery state, on a slowed-down phone.
frames state="agent-speaking":
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/frames.ts {{ state }}

# The core alone in Node, as a host other than the page has it: hears a
# scenario of bench/scenarios.ts in real time and prints the turns it ends.
core scenario="turns":
    pnpm exec tsx bench/core.ts {{ scenario }}
