# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm exec tsc -p .
    pnpm exec tsc -p voice
    pnpm build

# The page built from here, served with the agents of this machine, as the
# machine's own server does, at localhost:`port`.
serve port="8790": build
    node server/main.ts --port {{ port }}

build:
    pnpm build

# The page to try voice on, at localhost:5173, live as it is edited, with the
# agents of the server at localhost:`port`, such as the machine's own.
dev port="8790":
    AGENTVOICE_PORT={{ port }} pnpm dev

# Plays a scenario of bench/scenarios.ts, or a recording's WAV, into the page
# built from here, in a call with a scripted agent, and measures how its turns
# reached it.
bench scenario="turns":
    pnpm build
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/bench.ts {{ scenario }}

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
