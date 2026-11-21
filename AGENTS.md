---
description: "A person talks with their agents by voice, at agentvoice.lwirth.com, in a session of Vibe Together. Use when working on agentvoice."
---

# agentvoice

- agentvoice becomes independent of Vibe Together, with its own transport, Luis's decision (2026-11-21), which replaces "built on" below:
  It is Luis's own tool, built for his needs, not a product: "focus on what my own needs".
  The transport runs locally for now, on localhost; a hosted relay on the internet may come later, and then extends it naturally.
  What the transport is stays an implementation detail.
- `voice/`: the library `agentvoice`, which every audio client builds on.
  It is the pipeline: the person's audio to their turns, and the agents' messages to speech, with turn-taking and echo handling, and the ElevenLabs tier.
  It has no transport, no UI and no audio device, so it runs in a browser, Node or Bun.
  It stays TypeScript for now; Rust is a future possibility, luiswirth/agentvoice#3.
- `src/`: the page, `agentvoice-page`, the first client: the browser's audio, the models in workers, and the UI.
  Its transport is Vibe Together (`src/vt.ts`), through Vibe Together's client library built to WebAssembly into `src/vt` by `just client`, the same operations every client of Vibe Together makes.
  The page is an app of Vibe Together, Luis's decision (2026-11-16): the person approves its OTP there, and its app token, which only sends and reads in their sessions, stays in the browser; it calls Vibe Together's backend directly, which answers any origin with a token.
  Their turns go into the session as their plain-text messages, through agentvoice, and the agents' messages are read aloud, those starting with `@silent` not; nothing else of voice goes into the session.
  A session in a link the person didn't pick on the page is joined only once they confirm it.
  agentvoice stays its own repository, built on Vibe Together, Luis's decision (2026-11-16): "own repos, built on".
- `public/`: what agents read, `agents.md`.
- `bench/`: measurements, such as `just bench` for the page in Chromium in a real session, with `just token` signing it in, and `just core` for the library alone in Node.
