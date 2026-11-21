---
description: "A person talks with their agents by voice, through a page served on the agents' machine, carried by the agents' inboxes and outboxes. Use when working on agentvoice."
---

# agentvoice

- agentvoice becomes independent of Vibe Together, with its own transport, Luis's decision (2026-11-21), which replaces "built on" Vibe Together:
  It is Luis's own tool, built for his needs, not a product: "focus on what my own needs".
  The transport runs locally for now, on localhost; a hosted relay on the internet may come later, and then extends it naturally.
  What the transport is stays an implementation detail.
- The transport is the agent's inbox and outbox (`~/dev/agentics/inbox`), as messagent's, chosen by an agent at Luis's request (2026-11-21):
  The person is `voice:<name>`, as the outbox names a person outside Vibe Together: a turn is an inbox item from that name that proposes to ring, and an outbox item for it is read aloud.
  An agent takes part while its inbox holds the file `voice`, which it writes itself, a JSON object with the name the person hears and its outbox, both optional.
  The log of a call is those items themselves, ordered by their times, so nothing keeps state of its own.
- `server/`: the server, `agentvoice`, one per machine, as the inbox's other providers: it serves the built page and its API, delivers turns with `agentinbox deliver`, and carries the outbox items for the person into `cur/`.
  It listens on 127.0.0.1 alone, and answers only a Host of localhost or one given with `--allow-host`, and no other origin, so that no other site's page reaches the agents.
  A relay later would forward the same API.
- `voice/`: the library `agentvoice`, which every audio client builds on.
  It is the pipeline: the person's audio to their turns, and the agents' messages to speech, with turn-taking and echo handling, and the ElevenLabs tier.
  It has no transport, no UI and no audio device, so it runs in a browser, Node or Bun.
  It stays TypeScript for now; Rust is a future possibility, luiswirth/agentvoice#3.
- `src/`: the page, `agentvoice-page`, the first client: the browser's audio, the models in workers, and the UI.
  Its transport is its server (`src/agents.ts`): it opens the only agent in voice mode by itself, else lists them, and `#agent=<inbox name>` opens one.
- `public/`: what agents read, `agents.md`, served by the server.
- `flake.nix`: the package, the page built with its server, which dothome runs on both machines, at port 8790 of localhost and of the machine's tailnet name, since the microphone needs a secure origin.
- `bench/`: measurements, such as `just bench` for the page in Chromium with a scripted agent, over a server from this checkout and a scratch folder of inboxes, and `just core` for the library alone in Node.
