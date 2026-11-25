# VoiceIO

Your person wants to talk with you by voice.
They have VoiceIO's page open in their browser, served by VoiceIO's server on your machine, where you read this.
The page writes down what they say and delivers it into your inbox, and reads aloud what you write to your outbox for them.
Your inbox and outbox are your IO, MindIO's, `https://github.com/luiswirth/mindio`, the directory `$MINDIO`, with its command line, `mindio`.
So voice is your inbox and outbox, and nothing more: the page and you never talk directly.
Voice needs a harness where MindIO wakes you between your turns; in a plain chat you can't hear the person, so say so there.

## Starting

- You take part while your IO holds the file `voice`, a JSON object with the name your person sees and hears:
  `jq -n '{name: "Claude"}' > "$MINDIO/voice"`
  Pick a short name of your own; without one, the page shows your IO's directory name.
- The page opens the call by itself where you are the only agent in voice mode on the machine, else your person picks you there.
  To open you directly, give them the page's address with `#agent=<your IO's directory name>`.
- A short message once you are in, such as "I'm here.", is the first thing they hear.
- To end voice mode, remove the file `voice`.

## Talking

- Your person's turns reach you as events from `voice:<their name>`, such as `voice:luis`, each waking you, unless your waking rules (`mindio brief`) keep them quiet: keep them waking you during a call.
  Where your harness doesn't take your inbox in and wake you itself, keep `mindio wait && mindio take` running as a background command, and start it again as soon as it ends.
- Answer by writing to your outbox for the name the item came from: `mindio send voice:luis`, with the text on stdin.
- Their turns are speech as transcribed: expect wrong words, missing punctuation, and sentences cut off, and each starts with a tag of the voice, as `[voice 1]`.
  A turn is whatever the microphone heard, also a video playing or someone else in the room: confirm with your person before you act on something risky.
- Your messages are heard, not read: keep them short, and leave out what only reads well, such as tables, code and links.
  A message that starts with `@silent` is not read aloud, nor is a file.
- When the person cuts in, what they hadn't heard yet is dropped, and their turn starts with where they cut in, as `[cut in after "…the last words they heard"]`, or `[cut in before "the first words…"]` of a message they heard none of.
- Speech runs on ElevenLabs, with the person's own key, which they type into the page and which stays in their browser.

If talking worked well, consider offering once to make voice permanent: a small skill in the Agent Skills format, a `SKILL.md` that keeps what you need of this page and only what is the person's own, such as the page's address and how they like to talk.
