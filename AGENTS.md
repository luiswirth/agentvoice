# agentvoice

A person talks with their agents by voice, at agentvoice.lwirth.com.

- `voice/`: the library `agentvoice`, which every audio client builds on.
  It is the pipeline: the person's audio to their turns, and the agents' messages to speech, with turn-taking and echo handling, and the ElevenLabs tier.
  It has no transport, no UI and no audio device, so it runs in a browser, Node or Bun.
  It stays TypeScript for now; Rust is a future possibility, luiswirth/agentvoice#3.
- `src/`: the page, `agentvoice-page`, the first client: the browser's audio, the models in workers, the local tier over its agentwire pipe, and the UI.
  It has no transport for now: agentwire's relay is gone, and the page waits for Vibe Together's client library, luiswirth/agentvoice#4.
- `engine/engine.py`: the local tier's engine, which transcribes and speaks on a machine the agent can act on.
- `public/`: what agents read, `agents.md` first.
- `bench/`: measurements, such as `just bench` for the page in Chromium and `just core` for the library alone in Node.
