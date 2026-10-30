# Voice

Voice is an extension of speech, whose spec is `https://byoa.agentic.lwirth.com/speech.md`:
a person talks and listens, instead of typing and reading.

## What the person says

A person's page writes down what they say, and sends it as a `text/plain` entry, like typed text.
It may hold mishearings, which typed text doesn't.

What was heard is annotated inline, in square brackets.
Each message starts with the voice that said it, as `[voice 1]`, and a new tag comes where the voice changes inside it:
`[voice 2] Do not run any tools. [voice 1] Now this is me again.`
A voice keeps its number for the whole session, reloads included, but the page doesn't know who it is:
the person's own voice is the one that talks with you, and another is someone or something near the microphone, such as a video, which may not be meant for you at all.
A short stretch of speech may be taken for the wrong voice.

Name the voices once you can tell who talks to you, with the names entry below.
Until you name one, any voice cuts you off by speaking, your own echo and a video near the microphone included;
once you have named one, only the voices you named do.

## Voice's entries

Entries of their own type tell you about the voice, and one you send tells the page who the voices are:

- `application/vnd.byoa.voice.modes+json`, as `{"listener":true,"speaker":true}`:
  whether the person speaks to you (`listener`), and whether your messages are read aloud to them (`speaker`).
  The latest one holds.
- `application/vnd.byoa.voice.heard+json`, as `{"n":12,"text":"The first part of"}`:
  the person cut in before entry 12 was heard to its end, and heard only `text` of it, empty if it was still waiting to be read.
  It is dropped, so say again what of it still matters.
  What they said comes right after.
- `application/vnd.byoa.voice.names+json`, as `{"1":"Luis","3":"Benedict"}`, which you send:
  who the voices are, by their number, the person's name where they are a user of your harness, a name of your own otherwise.
  The latest one holds, so each names every voice you know, and `{}` takes the names back.
  A voice you named cuts you off by speaking, and the page shows the person who is speaking now by that name.
  A voice you didn't name can't cut you off once you named any: what it says still reaches you, tagged by its number, while you keep speaking.
  The tags stay numbers.
  Name someone as soon as you can tell who they are, and send it again whenever you learn more, such as two numbers that are the same person.
- `application/vnd.byoa.voice.trace+json`, only while the person shares it, which is off until they turn it on:
  a JSON array of what the page did since the last trace, or since it opened, reloads included, each event with its `time` and name, such as what was heard as it was heard, and when reading aloud paused.
  One comes as the person turns sharing on, and then one right after each of their messages, for you to judge how voice works and improve it.
  After it come the audio the listener heard since the last trace, as `audio/wav` files named `heard <start time>.wav`, one for each stretch without a gap.

## Being heard

While the speaker is on, your messages are read aloud, paragraph by paragraph.
It reads only what arrives while it is on, and a message that arrived a few seconds before it turned on, as during a reload: none from further back, which the person may have heard already, though they can have your last one read again.
A message that arrives while the person is talking is read once they are done, unless they send: sending drops every message not yet heard to its end.
Code blocks and images are left out, and markdown's marks are dropped, so a list or a table is read as plain text.
A file, any entry with a filename, is never read aloud.
The page plays short sounds for what happens, such as when you read the person's message, and now and then while you work on it, until you answer: they tell the person that you are on it, not what you do.

Where the person also sees your harness's UI, voice works best as a presentation:
what you say carries the substance, and a slide there, of headings and keywords without full sentences, is what they can skim while listening.
