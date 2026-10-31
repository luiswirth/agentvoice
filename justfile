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

# Builds the page and serves it at voice.agentics.lwirth.com.
deploy: pinned ci
    pnpm exec wrangler deploy --domain voice.agentics.lwirth.com

# Moves the lock to the newest commits of polylogue and polylogue-web.
bump:
    pnpm update polylogue polylogue-web

# Fails where the lock pins polylogue or polylogue-web behind its newest
# commit, which the page would otherwise be built against unnoticed.
pinned:
    #!/usr/bin/env bash
    set -euo pipefail
    for repo in polylogue polylogue-web; do
        head=$(git ls-remote "https://github.com/luiswirth/$repo" HEAD | cut -f1)
        grep -q "luiswirth/$repo/tar.gz/$head" pnpm-lock.yaml \
            || { echo "$repo is pinned behind $head: run just bump" >&2; exit 1; }
    done

# Screenshots of the voice bar in each state of bench/gallery-states.ts, on a
# Mac's window and an iPhone's, into bench/.cache/gallery/.
gallery:
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/gallery.ts

# Screenshots of the onboarding, step by step, with a scripted agent on the
# real relay, into bench/.cache/onboarding-pages/.
onboarding-pages:
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/onboarding-pages.ts

# The page's cues as one WAV to listen to, into bench/.cache/sounds.wav.
sounds:
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/sounds.ts

# What the page tells of an agent, as agents.md has it take part, against the
# real relay.
activity:
    pnpm exec tsx bench/activity.ts
