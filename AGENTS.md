---
description: "VoiceIO: a person talks with their agents by voice, through a page served on the agents' machine, carried by the agents' IO, MindIO. Use when working on VoiceIO."
---

# VoiceIO

- VoiceIO is built on MindIO (`~/dev/agentics/mindio`), Luis's decision (2026-11-25): "Wir haben einen Grundbaustein, MindIO, und VoiceIO ist obendrauf."
  So it is named VoiceIO, and its repository, package and command `voiceio`.
- VoiceIO becomes independent of Vibe Together, with its own transport, Luis's decision (2026-11-21), which replaces "built on" Vibe Together:
  It is Luis's own tool, built for his needs, not a product: "focus on what my own needs".
  The transport runs locally for now, on localhost; a hosted relay on the internet may come later, and then extends it naturally.
  What the transport is stays an implementation detail.
- The transport is the agent's inbox and outbox, its MindIO, as messagent's, chosen by an agent at Luis's request (2026-11-21):
  The person is `voice:<name>`, as the outbox names a person outside Vibe Together: a turn is an event from that name, which the agent's waking rules decide on, and an outbox item for it is read aloud.
  An agent takes part while its IO holds the file `voice`, which it writes itself, a JSON object with the name the person hears, optional.
  The log of a call is those items themselves, ordered by their times, so nothing keeps state of its own.
- Voice gives one agent an ear and a mouth, Luis's decision (2026-11-25): "Es ist genau für einen Agent und ein Mikrofon/Speaker. Oder wir geben dem einen Agent einfach ein Gehör und ein Maul. Das ist alles. Und dann der Rest kommt da raus."
  A conversation is only one use, a meeting the agent listens to and cuts in on is another: "dass der Agent ausgestattet wird mit der Möglichkeit, Sprache auditiv wahrzunehmen und Sprache auditiv auszugeben".
  Addressing a person, as `voice:<name>`, is a leftover of Vibe Together, not part of the design.
  Not built yet: the core design is to be paired.
- `server/`: the server, `voiceio`, one per machine, as MindIO's other providers: it serves the built page and its API, delivers turns with `mindio deliver`, and carries the outbox items for the person into `cur/`.
  It listens on 127.0.0.1 alone, and answers only a Host of localhost or one given with `--allow-host`, and no other origin, so that no other site's page reaches the agents.
  A relay later would forward the same API.
- `voice/`: the library `voiceio`, which every audio client builds on.
  It is the pipeline: the person's audio to their turns, and the agents' messages to speech, with turn-taking and echo handling, and the ElevenLabs tier.
  It has no transport, no UI and no audio device, so it runs in a browser, Node or Bun.
  It stays TypeScript for now; Rust is a future possibility, luiswirth/voiceio#3.
- `src/`: the page, `voiceio-page`, the first client: the browser's audio, the models in workers, and the UI.
  Its transport is its server (`src/agents.ts`): it opens the only agent in voice mode by itself, else lists them, and `#agent=<the agent's IO directory name>` opens one.
- `public/`: what agents read, `agents.md`, served by the server.
- `flake.nix`: the package, the page built with its server, which dothome runs on both machines, at port 8790 of localhost and of the machine's tailnet name, since the microphone needs a secure origin.
- `bench/`: measurements, such as `just bench` for the page in Chromium with a scripted agent, over a server from this checkout and a scratch folder of agents' IO, and `just core` for the library alone in Node.
