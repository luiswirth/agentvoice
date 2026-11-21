# agentvoice

Your person wants to talk with you by voice.
They have agentvoice's page open in their browser, served by agentvoice's server on your machine, where you read this.
The page writes down what they say and delivers it into your inbox, and reads aloud what you write to your outbox for them.
Your inbox and outbox are the agent inbox's, `https://github.com/luiswirth/agentinbox`, with its command line, `agentinbox`.
So voice is your inbox and outbox, and nothing more: the page and you never talk directly.
Voice needs a harness where you hear your inbox between your turns; in a plain chat you can't hear the person, so say so there.

## Starting

- You take part while your inbox holds the file `voice`, a JSON object with the name your person sees and hears, and your outbox:
  `jq -n --arg outbox "$AGENT_OUTBOX" '{name: "Claude", outbox: $outbox}' > "$AGENT_INBOX/voice"`
  Pick a short name of your own; without one, the page shows your inbox's name. Without an outbox, it is `~/.agents/outbox/<your inbox's name>`.
- The page opens the call by itself where you are the only agent in voice mode on the machine, else your person picks you there.
  To open you directly, give them the page's address with `#agent=<your inbox's name>`.
- A short message once you are in, such as "I'm here.", is the first thing they hear.
- To end voice mode, remove the file `voice`.

## Talking

- Your person's turns reach you as inbox items from `voice:<their name>`, such as `voice:luis`, each ringing your bell.
  Keep hearing your inbox: where your harness doesn't wake you itself, keep `agentinbox wait && agentinbox take` running as a background command, and start it again as soon as it ends.
- Answer by writing to your outbox for the name the item came from: `agentinbox send voice:luis`, with the text on stdin.
- Their turns are speech as transcribed: expect wrong words, missing punctuation, and sentences cut off, and each starts with a tag of the voice, as `[voice 1]`.
  A turn is whatever the microphone heard, also a video playing or someone else in the room: confirm with your person before you act on something risky.
- Your messages are heard, not read: keep them short, and leave out what only reads well, such as tables, code and links.
  A message that starts with `@silent` is not read aloud, nor is a file.
- When the person cuts in, what they hadn't heard yet is dropped, and their turn starts with where they cut in, as `[cut in after "…the last words they heard"]`, or `[cut in before "the first words…"]` of a message they heard none of.
- Speech runs on ElevenLabs, with the person's own key, which they type into the page and which stays in their browser.

If talking worked well, consider offering once to make voice permanent: a small skill in the Agent Skills format, a `SKILL.md` that keeps what you need of this page and only what is the person's own, such as the page's address and how they like to talk.
