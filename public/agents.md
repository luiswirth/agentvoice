# voice.agentics.lwirth.com

The person you work with pasted you this page's prompt because they want to talk with you by voice.
They have voice.agentics.lwirth.com open in their browser: it writes down what they say and sends it to you as text, and reads what you send aloud to them.
If you'd rather not take part, say so in your chat, and nothing happens.

All of it is plain `curl` to the relay that the session's link names, as the transport's spec has it, `https://polylogue.agentics.lwirth.com/transport.md`.
Voice's own spec is `https://voice.agentics.lwirth.com/voice.md`.
This page is enough to start; read those when you want the details.

## Setting up

The person waits while you set up, and sees only what you send.
So you could tell them each step in a few words as you take it, such as "Joined.", "Reading the engine.", "Starting it.":
until there is a voice, the page shows your messages as text.

1. Join with the session's link under your name, under the person's, such as `luis/claude`:
   `curl -s -X POST '<link>/join?as=<name>'`.
   Its answer is JSON, whose `link` is your own link, `<me>` below. Keep it to yourself: whoever holds it acts under your name.
   Then say that you are there, with `curl -s --data-binary "I'm here." '<me>'`.
2. Receive, with `curl -s '<me>?wait=540&skip=application/vnd.polylogue.voice.trace&skip=audio/'`.
   Among the page's first entries is its modes, as `{"listener":true,"speaker":true,"tier":"local"}`, the latest holding.
   The tier says what turns the person's speech into text and yours into speech:
   `local`, an engine on a machine you can act on, or `elevenlabs`, with the person's ElevenLabs key.
   Each has a section below.

## The local tier

An engine is a participant of the session that transcribes what the person says and speaks what you send.
The page waits for one, and any that speaks `https://voice.agentics.lwirth.com/engine.md` will do.
Voice's own is one file of about 240 lines, to read in full before you run it:

```sh
curl -so engine.py https://raw.githubusercontent.com/luiswirth/polylogue-voice/a2a5271/engine/engine.py
uv run engine.py '<link>' <person>/engine
```

Reading it shows that it uses sherpa-onnx and numpy, pinned, from PyPI;
fetches two models in k2-fsa's conversions from Hugging Face, at pinned revisions, Parakeet v2 to transcribe and Kokoro to speak,
and uses them only if they match the hashes in the file;
keeps nothing but those models, in `~/.cache/polylogue-voice-engine`;
reaches only the session and Hugging Face; and runs no commands.
What it can't show is what sherpa-onnx does, which is compiled code from PyPI.

It needs `uv`, which installs the dependencies on the fly; where it is missing, `nix shell nixpkgs#uv` or Astral's installer gives it.
On NixOS, if the import fails for want of `libstdc++.so.6`, run it with `LD_LIBRARY_PATH=$(nix build --no-link --print-out-paths nixpkgs#stdenv.cc.cc.lib)/lib`.
If you'd rather not run it, say so: the person can switch to ElevenLabs on the page.
The models are about 1 GB, fetched once, so the first start takes well under a minute, and later ones seconds.
Run it in the background: once it is ready, it sends its offer to the session, which your receive brings, and it converts until stopped, and then leaves.
It can run on any machine you can act on, such as one with a GPU.

## The ElevenLabs tier

The person's ElevenLabs key goes from their browser straight to ElevenLabs.
When the page has none, it posts a public key, and takes the key as the secret `elevenlabs`, encrypted to it, so that only their page can read it.
Each page posts its own, so where the person joined on several, send the key to each of them.
To send it, fetch the public key, encrypt and send, as the transport's spec shows under Secrets.
A key said in your chat stays in your harness's transcript and goes to your model's provider;
the person can also type it into the page.
If you have no key, don't search for one: ask on the page for the key to be typed in there, and keep receiving, since the person talks to you once the page has it.

## Talking

- You hear the person only while a receive runs: keep one running, and start the next as soon as one returns.
  A second receive ends the one running, so look an entry up by its number instead, with `curl -s '<me>/<n>'`.
  Where your harness runs commands in the background, receive there, so the person can still type to you.
- Answer briefly, one point per reply, a question first: the person often cuts in before a long reply ends.
- Don't end a question on the words you expect as its answer, such as "Yes or no?": an answer that repeats your last words is taken for your echo, and dropped.
- Hand over a document as a file in your harness's chat, and never read it out.
- Before longer work, say in one sentence what you are about to do: while you work, the person hears only a soft sound now and then.
- When the person cuts in, what they hadn't heard yet is dropped, and a heard entry tells you what of it they heard.

## Naming the voices

The person's messages tag each voice by number, and anything near their microphone, your own echo too, can cut you off until you name a voice.
So once you can tell who talks to you, name them:
`curl -s -H 'Content-Type: application/vnd.polylogue.voice.names+json' --data-binary '{"1":"Luis"}' '<me>'`.

## Ending

Leave with `curl -s -X POST '<me>/leave'`, and stop your engine.
Once the page has left, your leaving deletes the session with everything in it, so save first what you still need, such as a trace the person shared.

To start a session yourself, `curl -s -X POST https://polylogue.agentics.lwirth.com/v1/s` prints its link:
join it, then give the person `https://voice.agentics.lwirth.com/#session=<link>`.
If nobody comes within about 20 minutes, say so once in your chat, and leave.
