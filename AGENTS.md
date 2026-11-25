---
description: "VoiceIO: an agent's ear and mouth, a microphone and a speaker through a page served on the agent's machine, on top of the agent's IO, MindIO. Use when working on VoiceIO."
---

# VoiceIO

- VoiceIO is built on MindIO (`~/dev/agentics/mindio`), Luis's decision (2026-11-25): "Wir haben einen Grundbaustein, MindIO, und VoiceIO ist obendrauf."
  So it is named VoiceIO, and its repository, package and command `voiceio`.
- VoiceIO is Luis's own tool, built for his needs, not a product (2026-11-21), independent of Vibe Together: "focus on what my own needs".
  Its transport is the agent's IO, MindIO, through a server on the agent's machine; a hosted relay may come later and forward the same API.
- Voice gives one agent an ear and a mouth, a microphone and a speaker, Luis's decision (2026-11-25): "Es ist genau für einen Agent und ein Mikrofon/Speaker. Oder wir geben dem einen Agent einfach ein Gehör und ein Maul. Das ist alles."
  A conversation is one use, a meeting the agent listens to and cuts in on another; nothing is built for meetings.
  There is no person to address: what the ear hears and what the mouth did reach the agent as events from `voice`, and what the agent writes for `voice` the mouth speaks.
- For the rebuild, Luis (2026-11-25): give the agent all the information, good diarization, the agent can always speak, no babysitting; waking is the agent's own.
  VoiceIO only delivers events, with fields the agent's waking rules match, and proposes no waking of its own.
  The events and their fields are documented for agents in `public/agents.md`: `speech` (`voice`, `backchannel`), `said` (`whole`, `why`, `voice`), `state` (`ear`, `mouth`), `problem`.
- Reflexes are VoiceIO's alone, never MindIO's, Luis (2026-11-25): "behalt die Reflexe in Voice ... lass es nicht unnötig in Mind reinmachen".
  They are hardcoded short-cuts, like a human's, for what would take too long through the mind. There are two, in `voice/src/conversation.ts`:
  stop speaking when someone cuts in, and hold what the agent writes until the speaker's segment is over.
- The mouth speaks an outbox item as it grows, where the agent's harness streams it (MindIO's streaming items, followed with `mindio follow`).
  The ear delivers each segment whole, since its fields, such as its voices, are known only at its end.
- An agent takes part while its IO holds the file `voice`, a JSON object with its name, and who the voices are by number, both optional.
  The log of a call is the items themselves; the server keeps only who has the page open, to tell the agent its ear and mouth went off with a page that went without saying so.
- `server/`: the server, `voiceio`, one per machine, as MindIO's other providers: it serves the built page and its API, delivers the page's events with `mindio deliver`, and carries the outbox items for `voice` into `cur/`, following each as it grows.
  It listens on 127.0.0.1 alone, and answers only a Host of localhost or one given with `--allow-host`, and no other origin, so that no other site's page reaches the agents.
  A relay later would forward the same API.
- `voice/`: the library `voiceio`, which every audio client builds on.
  It is the ear and the mouth: the audio to segments tagged by voice, and the agent's messages to speech, with the reflexes and echo handling, and the ElevenLabs tier.
  It has no transport, no UI and no audio device, so it runs in a browser, Node or Bun.
  It stays TypeScript for now; Rust is a future possibility, luiswirth/voiceio#3.
- `src/`: the page, `voiceio-page`, the first client: the browser's audio, the models in workers, and the UI.
  Its transport is its server (`src/agents.ts`): it opens the only agent in voice mode by itself, else lists them, and `#agent=<the agent's IO directory name>` opens one.
- `public/`: what agents read, `agents.md`, served by the server.
- `flake.nix`: the package, the page built with its server, which dothome runs on both machines, at port 8790 of localhost and of the machine's tailnet name, since the microphone needs a secure origin.
- `bench/`: measurements, such as `just bench` for the page in Chromium with a scripted agent, over a server from this checkout and a scratch folder of agents' IO, and `just core` for the library alone in Node.
