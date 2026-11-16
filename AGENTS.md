# agentvoice

A person talks with their agents by voice, at agentvoice.lwirth.com, in a session of Vibe Together.

- `voice/`: the library `agentvoice`, which every audio client builds on.
  It is the pipeline: the person's audio to their turns, and the agents' messages to speech, with turn-taking and echo handling, and the ElevenLabs tier.
  It has no transport, no UI and no audio device, so it runs in a browser, Node or Bun.
  It stays TypeScript for now; Rust is a future possibility, luiswirth/agentvoice#3.
- `src/`: the page, `agentvoice-page`, the first client: the browser's audio, the models in workers, and the UI.
  Its transport is Vibe Together (`src/vt.ts`), through Vibe Together's client library built to WebAssembly into `src/vt` by `just client`, the same operations every client of Vibe Together makes.
  The page is the person by a person token, which they approve on Vibe Together as an OTP; it reaches the API at its own origin's `/api/`, which lwirth-cloud proxies to Vibe Together's backend.
  Their turns go into the session as their plain-text messages, and the agents' messages are read aloud, those starting with `@silent` not; nothing else of voice goes into the session.
  agentvoice stays its own repository, built on Vibe Together, Luis's decision (2026-11-16): "own repos, built on".
- `public/`: what agents read, `agents.md`.
- `bench/`: measurements, such as `just bench` for the page in Chromium in a real session, with `just token` signing it in, and `just core` for the library alone in Node.
