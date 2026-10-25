# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm exec tsc -p .
    pnpm build

# The page to try voice on, at localhost:5173.
dev:
    pnpm dev

# Plays a scenario of bench/scenarios.ts, or a recording's WAV, into the page
# built from here, and measures how its turns reached a fake agent.
bench scenario="turns":
    pnpm build
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/bench.ts {{ scenario }}

# Joins the audio a page shared into the session at `link` into one WAV, for
# `just bench` to replay.
recording link out="recording.wav":
    pnpm exec tsx bench/recording.ts {{ link }} {{ out }}

# Builds the page and serves it at voice.senses.sh.
deploy: ci
    pnpm exec wrangler deploy --domain voice.senses.sh

# Screenshots of the voice bar in each state of bench/gallery-states.ts, on a
# Mac's window and an iPhone's, into bench/.cache/gallery/.
gallery:
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/gallery.ts

# The page's cues as one WAV to listen to, into bench/.cache/sounds.wav.
sounds:
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/sounds.ts

# What the page tells of an agent, as agents.md has it take part, against the
# real relay.
activity:
    pnpm exec tsx bench/activity.ts
