# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm exec tsc -p .
    pnpm exec tsc -p core
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

# Records a script of bench/conversation.ts as ground truth into `out`:
# plays the agent in a real voice session, and serves a prompter at `port`
# that tells the person what to say.
record out script="conversation" port="8794":
    pnpm exec tsx bench/record.ts {{ out }} {{ script }} {{ port }}

# Labels a recording of `just record` with when each line was said, into
# labels.json beside it.
label dir:
    pnpm exec tsx bench/label.ts {{ dir }}

# Builds the page and serves it at voice.agentics.lwirth.com, from lwirth-cloud,
# whose serve.nix in dotcloud says how.
deploy: pinned ci
    rsync -rlpt --delete --delay-updates --chmod=D755,F644 dist/ root@lwirth-cloud:/srv/voice/

# Moves the lock to the newest commits of agentwire and polylogue-web.
bump:
    pnpm update agentwire polylogue-web

# Fails where the lock pins agentwire or polylogue-web behind its newest
# commit, which the page would otherwise be built against unnoticed.
pinned:
    #!/usr/bin/env bash
    set -euo pipefail
    for repo in agentwire polylogue-web; do
        head=$(git ls-remote "https://github.com/luiswirth/$repo" HEAD | cut -f1)
        pin=$(grep -o "luiswirth/$repo/tar.gz/[0-9a-f]*" pnpm-lock.yaml | head -1 | cut -d/ -f4)
        [ "$pin" = "$head" ] && continue
        # Only a commit to what the package holds puts the pin behind.
        packaged=$(gh api -H "Accept: application/vnd.github.raw" "repos/luiswirth/$repo/contents/package.json" \
            | jq -r '"package.json", (.files[] + "/")')
        changed=$(gh api "repos/luiswirth/$repo/compare/$pin...$head" --jq '.files[].filename')
        for path in $packaged; do
            if grep -qxF -e "$path" <<<"$changed" || grep -q "^$path" <<<"$changed"; then
                echo "$repo is pinned behind $head, which changes $path: run just bump" >&2
                exit 1
            fi
        done
    done

# Screenshots of the call in each state of src/demo/states.ts, on a
# Mac's window and an iPhone's, into bench/.cache/gallery/.
gallery:
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/gallery.ts

# Screenshots of the onboarding, step by step, with a scripted agent on the
# real relay, into bench/.cache/onboarding-pages/.
onboarding-pages:
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/onboarding-pages.ts

# The page's cues as one WAV to listen to, into bench/.cache/sounds.wav.
sounds:
    pnpm exec tsx bench/sounds.ts

# What the page tells of an agent, as agents.md has it take part, against the
# real relay.
activity:
    pnpm exec tsx bench/activity.ts

# How smoothly the page runs in a gallery state, on a slowed-down phone.
frames state="agent-speaking":
    CHROMIUM="$(command -v chromium)" pnpm exec tsx bench/frames.ts {{ state }}

# The core alone in Node, as a host other than the page has it: hears a
# scenario of bench/scenarios.ts in real time and prints the turns it ends.
core scenario="turns":
    pnpm exec tsx bench/core.ts {{ scenario }}
