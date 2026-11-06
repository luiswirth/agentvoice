# Engine

Engine is an extension of polylogue, on the agentwire transport, at `https://agentwire.agentics.lwirth.com/agentwire.md`:
a program that turns speech into text and text into speech for a client, such as the voice page.
The page uses one when the person chooses the local tier, so that their voice is heard and spoken on a machine their agent can act on, rather than by ElevenLabs.

An engine is no participant of the conversation, but a part of its client.
Where it runs on another machine than the client, as for the voice page, the two talk over a pipe: an agentwire session of their own, that no one else is in.
This extension is what they say there.
Whoever starts the engine gives it the pipe's link, and the client the same link;
voice's page gets it from the agent, as `https://voice.agentics.lwirth.com/agents.md` has it.
The engine leaves the pipe once everyone else has left it, which ends the pipe.

An engine only converts.
It decides nothing about turns, voices or interruptions, which stay with the client,
and keeps no state beyond its models and the stretches of speech still coming in.
Anyone may run one, with any models: voice's own is one short file, `https://github.com/luiswirth/polylogue-voice/blob/main/engine/engine.py`.

## Entries

Every entry of the extension has a type starting with `application/vnd.polylogue.engine.`.
An answer names the entry it answers in its type, as `; of=<n>`.

- `application/vnd.polylogue.engine.status+json`, as `{"text":"Fetching the models: 420 of 1010 MB."}`, which the engine may send before its offer:
  what it is doing, for the person to see while they wait.
  The latest one holds.
- `application/vnd.polylogue.engine.offer+json`, as `{"transcription":"parakeet-tdt-0.6b-v2-int8","synthesis":"kokoro-v1.0","voices":["af_heart","af_bella"],"source":"<url>"}`, which the engine sends once it has joined and its models are loaded:
  what it converts with, the voices it speaks with, the first where a request names none, and where its code is.
  Either job may be missing, for an engine that does only one.
  An engine counts while it is in the pipe; its latest offer holds.
- `application/vnd.polylogue.engine.transcribe`, a WAV of 16-bit mono PCM at 16 kHz:
  speech to transcribe: one stretch, from one pause to the next, after up to 2 s of the speech before it, which the client hears it in and drops the words of.
  The client sends a stretch as it is heard: the first entry opens it, each later one goes on with its audio and has `; of=<n>`, naming the first,
  and the last has `; end=<s>`, where the stretch ends, in seconds into its audio. A stretch heard at once is one entry with `end`.
- `application/vnd.polylogue.engine.transcript+json; of=<n>`, as `{"text":"Can you check the relay?","words":[{"text":"Can","start":0.12,"end":0.3}]}`:
  what was said in the stretch opened by entry `n`, with each word's start and end in seconds into its audio,
  once it ended.
  Before that, the engine may answer `; partial; of=<n>` with the words so far, each replacing the last.
- `application/vnd.polylogue.engine.synthesize+json`, as `{"text":"Sure, I'll look into it.","voice":"af_bella"}`:
  one sentence to speak, in one of the voices offered, if it names one.
- `application/vnd.polylogue.engine.speech; of=<n>`, a WAV of 16-bit mono PCM at 24 kHz:
  the sentence of entry `n`, spoken.

A request the engine can't answer gets `application/vnd.polylogue.engine.failed+json; of=<n>`, as `{"error":"…"}`.
