# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm exec tsc -p .
    pnpm exec tsc -p core
    pnpm build
    just engine-pinned

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

# Fails where agents.md has agents fetch an engine.py other than this one,
# or tells its length wrong: "about" a number of lines, to the nearest 50.
engine-pinned:
    #!/usr/bin/env bash
    set -euo pipefail
    pin=$(grep -o 'luiswirth/agentvoice/[0-9a-f]*/engine/engine.py' public/agents.md | cut -d/ -f3)
    if ! git show "$pin:engine/engine.py" | cmp -s - engine/engine.py; then
        echo "agents.md pins engine.py at $pin, which differs from engine/engine.py: commit it, then pin that commit" >&2
        exit 1
    fi
    lines=$(wc -l < engine/engine.py)
    about=$(grep -o 'about [0-9]* lines' public/agents.md | cut -d' ' -f2)
    if [ "$about" != $(( (lines + 25) / 50 * 50 )) ]; then
        echo "agents.md says engine.py is about $about lines, but it is $lines" >&2
        exit 1
    fi

# Moves agentwire's participant library and Vibe Together's ui, both from
# PotentialHedge/vibetogether, to its newest commit.
bump:
    #!/usr/bin/env bash
    set -euo pipefail
    head=$(git ls-remote https://github.com/PotentialHedge/vibetogether HEAD | cut -f1)
    for part in agentwire ui; do
        jq --arg part "$part" --arg spec "github:PotentialHedge/vibetogether#$head&path:/$part" \
            '.dependencies[$part] = $spec' package.json > package.json.new
        mv package.json.new package.json
    done
    pnpm install

# Fails where the lock pins agentwire or ui behind PotentialHedge/vibetogether's
# newest commit, which the page would otherwise be built against unnoticed.
# Only a commit that changes what one of them holds puts the pin behind.
pinned:
    #!/usr/bin/env bash
    set -euo pipefail
    head=$(git ls-remote https://github.com/PotentialHedge/vibetogether HEAD | cut -f1)
    pin=$(jq -r '.dependencies.agentwire' package.json | sed 's/.*#\([0-9a-f]*\)&.*/\1/')
    [ "$pin" = "$head" ] && exit 0
    changed=$(gh api "repos/PotentialHedge/vibetogether/compare/$pin...$head" --jq '.files[].filename')
    if grep -qE '^(agentwire/(package.json|participant/)|ui/)' <<<"$changed"; then
        echo "agentwire or ui is pinned behind $head, which changes them: run just bump" >&2
        exit 1
    fi

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
