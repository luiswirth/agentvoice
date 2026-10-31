# Engine

Engine is an extension of polylogue, whose transport is `https://polylogue.agentics.lwirth.com/transport.md`:
a participant that turns speech into text and text into speech for the others in a session.
The voice page uses one when the person chooses the local tier, so that their voice is heard and spoken on a machine their agent can act on, rather than by ElevenLabs.

An engine only converts.
It decides nothing about turns, voices or interruptions, which stay with the page,
and keeps no state beyond its models.
Anyone may run one, with any models: voice's own is one short file, `https://github.com/luiswirth/polylogue-voice/blob/main/engine/engine.py`.

## Entries

Every entry of the extension has a type starting with `application/vnd.polylogue.engine.`,
so a participant that leaves the conversion to the engine skips them with `skip=application/vnd.polylogue.engine.`.
An answer names the entry it answers in its type, as `; of=<n>`.

- `application/vnd.polylogue.engine.status+json`, as `{"text":"Fetching the models: 420 of 1010 MB."}`, which the engine may send before its offer:
  what it is doing, for the person to see while they wait.
  The latest one holds.
- `application/vnd.polylogue.engine.offer+json`, as `{"transcription":"parakeet-tdt-0.6b-v2-int8","synthesis":"kokoro-v1.0","voices":["af_heart","af_bella"],"source":"<url>"}`, which the engine sends once it has joined and its models are loaded:
  what it converts with, the voices it speaks with, the first where a request names none, and where its code is.
  Either job may be missing, for an engine that does only one.
  An engine counts while it is in the session; its latest offer holds.
- `application/vnd.polylogue.engine.transcribe`, a WAV of 16-bit mono PCM at 16 kHz:
  speech to transcribe: one stretch, from one pause to the next, after up to 2 s of the speech before it, which the page hears it in and drops the words of.
- `application/vnd.polylogue.engine.transcript+json; of=<n>`, as `{"text":"Can you check the relay?","words":[{"text":"Can","start":0.12,"end":0.3}]}`:
  what was said in the stretch of entry `n`, with each word's start and end in seconds into it.
- `application/vnd.polylogue.engine.synthesize+json`, as `{"text":"Sure, I'll look into it.","voice":"af_bella"}`:
  one sentence to speak, in one of the voices offered, if it names one.
- `application/vnd.polylogue.engine.speech; of=<n>`, a WAV of 16-bit mono PCM at 24 kHz:
  the sentence of entry `n`, spoken.

A request the engine can't answer gets `application/vnd.polylogue.engine.failed+json; of=<n>`, as `{"error":"…"}`.
