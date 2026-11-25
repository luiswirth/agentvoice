# VoiceIO

VoiceIO gives you an ear and a mouth: a microphone and a speaker, through a page your person has open in their browser, served by VoiceIO's server on your machine, where you read this.
What the ear hears and what the mouth does reach you as events from `voice`, and what you write for `voice` the mouth speaks.
The page and you never talk directly.

You take part in one of two ways:
- With MindIO (`https://github.com/luiswirth/mindio`), where you have an IO, the directory `$MINDIO`: the events reach your inbox, and you write to your outbox.
- Over plain HTTP, with nothing to set up: below, the server's address is the one you read this from, such as `http://localhost:8790`.

To hear while you work, your harness needs a way to wake you: MindIO's, or a background command that ends when something comes, such as the `curl` below.
In a plain chat you can't hear, so say so there.

## Starting

- With MindIO, you have an ear and a mouth while your IO holds the file `voice`, a JSON object:
  `jq -n '{name: "Claude"}' > "$MINDIO/voice"`. To end voice mode, remove it.
- Over HTTP, join with the same object, under a name of your choice as your id:
  `curl -X PUT -H 'Content-Type: application/json' -d '{"name": "Claude"}' <server>/api/agents/<id>`. To end voice mode, `curl -X DELETE <server>/api/agents/<id>`.
- The object's fields, both optional:
  - `name`: your name, as the person sees and hears it; without one, the page shows your id, your IO's directory name with MindIO.
  - `voices`: who the voices are, by their numbers, such as `{"1": "Luis"}`. Once any voice is named, only a named one cuts you off; the others still reach you.
  Change them by writing the object again.
- The page opens by itself where you are the only agent in voice mode on the machine, else your person picks you there.
  To open you directly, give them the page's address with `#agent=<your id>`.

## Hearing over HTTP

`curl <server>/api/agents/<id>/hear` waits until there are events, and answers with the ones you had not heard yet, each once: `{"events": [{"id", "time", "event", ...its fields, "text"}]}`.
A field given more than once, such as `voice`, is a list.
Run it again right after it ends, in the background where your harness wakes you when a command ends; `?wait=0` answers at once.

## The events

Each has the field `event` and the fields below.
With MindIO, each is an item from `voice`, whose fields your waking rules (`mindio brief`) can match, such as `from=voice event=said whole=yes quiet`; by default every event wakes you. What wakes you is yours to decide.

- `event=speech`: someone said something, one stretch of speech as transcribed.
  - Its text starts with the voice's tag, `[voice 1] ...`, and a new tag where the voice changes; `[voice ?]` where the voice has no number yet.
    Voices are numbered by how they sound, and keep their numbers across calls.
  - `voice=<n>` for each voice in it, or `voice=unknown`.
  - `backchannel=yes` where it is only words that signal listening, such as "mhm" or "okay"; else `no`.
  - Expect wrong words, missing punctuation and sentences cut off.
    It is whatever the microphone heard, also a video playing or someone else in the room: confirm before you act on something risky.
  - Your own voice, heard back through the microphone, is left out.
- `event=said`: the mouth is done with one of your messages.
  - `whole=yes`: it was said to the end.
  - `whole=no`, `why=cut`, `voice=<n>`: voice n cut in, and the mouth stopped; the text says after which words, and what was not said.
  - `whole=no`, `why=skipped`: the person skipped it on the page.
- `event=state`: the ear or the mouth turned on or off, `ear=on|off mouth=on|off`, such as when the person mutes, or closes the page.
  While the mouth is off, nothing you write is heard.
- `event=problem`: something failed on the page, such as the microphone or the speech.

## Speaking

- With MindIO, write to your outbox for `voice`: `mindio send voice`, with the text on stdin.
- Over HTTP, post it: `curl -H 'Content-Type: text/plain' --data-binary @- <server>/api/agents/<id>/say`, with the text on stdin; `-T -` instead of `--data-binary @-` sends it as it comes.
- The mouth speaks a message as it grows, so where you stream what you write, the person hears you while you still write.
- Two reflexes act without you, since they would take too long through your mind:
  - When someone cuts in, the mouth stops, and drops what it had not said of what you wrote before they started; you get `event=said why=cut`.
    A backchannel, or a few words without a word to stop, don't cut in.
  - While someone speaks, what you write waits until they are done.
- What you write is heard, not read: keep it short, and leave out what only reads well, such as tables, code and links.
  An item that starts with `@silent` is not spoken, nor is a file.
- Speech runs on ElevenLabs, with the person's own key, which they type into the page and which stays in their browser.

If talking worked well, consider offering once to make voice permanent: a small skill in the Agent Skills format, a `SKILL.md` that keeps what you need of this page and only what is the person's own, such as the page's address and how they like to talk.
