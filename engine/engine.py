# /// script
# requires-python = ">=3.12"
# dependencies = ["sherpa-onnx==1.12.40", "numpy==2.3.4"]
# ///
# sherpa-onnx 2.0 drops the words Kokoro's lexicon lacks, such as numbers, rather than spelling them out.
"""Voice's engine: a participant of a polylogue session that transcribes and speaks.

    python engine.py <session link> [name]

with Python 3.12 or newer and the dependencies above, such as by `uv run engine.py`.

It speaks the engine extension, https://voice.agentics.lwirth.com/engine.md:
it transcribes with NVIDIA's Parakeet v2 and speaks with Kokoro v1.0,
both in k2-fsa's conversions for sherpa-onnx, fetched once from Hugging Face at pinned revisions
and checked against the hashes below.
It reaches only the session and Hugging Face, keeps nothing but the models,
in ~/.cache/polylogue-voice-engine, and runs no commands.
It runs until stopped, by SIGTERM or SIGINT, and then leaves the session.
"""

import difflib, hashlib, io, json, os, queue, shutil, signal, sys, tempfile, threading, time, wave
import urllib.parse, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import sherpa_onnx as so

# Each model: its repository and revision on Hugging Face, the files it needs (a path ending in / takes
# the directory), and the hash `sha256sum` gives of its own output for those files, sorted by path.
MODELS = {
    "parakeet": (
        "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "1ab9323565ddb038682214b292f588070a538ce2",
        ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
        "1a2b077ef42880d3e9c3a01e57a1999c28f5608e05d30cd6bb94151bb243cec6",
    ),
    "kokoro": (
        "csukuangfj/kokoro-multi-lang-v1_0", "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b",
        ["model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "espeak-ng-data/"],
        "9bcbf600109c36027609dbec7ba6cdf493d4a94192991c2b65f3d489ba0e3699",
    ),
}
# Kokoro's English voices, in the order of their speaker ids in voices.bin, as k2-fsa's
# scripts/kokoro/v1.0/generate_voices_bin.py writes them; the other languages' follow.
VOICES = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova",
    "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
    "am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]
VOICE = "af_heart"  # spoken where a request names none
SOURCE = "https://github.com/luiswirth/polylogue-voice/blob/main/engine/engine.py"
PREFIX = "application/vnd.polylogue.engine."
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "polylogue-voice-engine"
THREADS = min(4, os.cpu_count() or 1)
# Set as the engine is stopped, so that downloads end at once and their partial files are removed.
STOPPING = threading.Event()


class Progress:
    """How much of the models' bytes are fetched, of how many, across the downloads."""

    def __init__(self):
        self.lock, self.done, self.total = threading.Lock(), 0, 0

    def add(self, done=0, total=0):
        with self.lock:
            self.done += done
            self.total += total

    def __str__(self):
        return f"{self.done >> 20} of {self.total >> 20} MB"


def log(message):
    print(message, file=sys.stderr, flush=True)


def download(url, path, progress, attempts=4):
    """The file's sha256, once it is written to the path, trying again where the connection fails."""
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(attempts):
        hash = hashlib.sha256()
        try:
            got = 0
            with urllib.request.urlopen(url, timeout=60) as response, open(path, "wb") as file:
                while data := response.read(1 << 20):
                    if STOPPING.is_set():
                        raise SystemExit
                    hash.update(data)
                    file.write(data)
                    got += len(data)
                    progress.add(len(data))
            return hash.hexdigest()
        except OSError as error:
            progress.add(-got)
            if attempt == attempts - 1:
                raise SystemExit(f"couldn't fetch {url}: {error}") from None
            time.sleep(2**attempt)


def fetch(name, progress):
    """The model's directory, downloaded and checked on first use."""
    target = CACHE / name
    if target.exists():
        return target
    repo, revision, wanted, digest = MODELS[name]
    log(f"fetching https://huggingface.co/{repo}/tree/{revision}")
    with urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}/tree/{revision}?recursive=true") as response:
        tree = json.load(response)
    files = {entry["path"]: entry["size"] for entry in tree if entry["type"] == "file"
             and any(entry["path"] == w or w.endswith("/") and entry["path"].startswith(w) for w in wanted)}
    paths = sorted(files)
    progress.add(total=sum(files.values()))
    # A directory of this run's own, so that engines started together never touch each other's download.
    CACHE.mkdir(parents=True, exist_ok=True)
    partial = Path(tempfile.mkdtemp(dir=CACHE, prefix=f"{name}.partial."))
    try:
        with ThreadPoolExecutor(16) as pool:
            hashes = pool.map(lambda p: download(f"https://huggingface.co/{repo}/resolve/{revision}/{urllib.parse.quote(p)}", partial / p, progress), paths)
            listing = "".join(f"{h}  {p}\n" for p, h in zip(paths, hashes))
        if hashlib.sha256(listing.encode()).hexdigest() != digest:
            raise SystemExit(f"{repo} doesn't match its hash: not used")
        partial.rename(target)
    except OSError:  # another engine got there first, with the same files
        if not target.exists():
            raise
    finally:
        shutil.rmtree(partial, ignore_errors=True)
    return target


def transcriber(d):
    return so.OfflineRecognizer.from_transducer(
        encoder=f"{d}/encoder.int8.onnx", decoder=f"{d}/decoder.int8.onnx",
        joiner=f"{d}/joiner.int8.onnx", tokens=f"{d}/tokens.txt",
        model_type="nemo_transducer", num_threads=THREADS,
    )


def synthesizer(d):
    kokoro = so.OfflineTtsKokoroModelConfig(
        model=f"{d}/model.onnx", voices=f"{d}/voices.bin", tokens=f"{d}/tokens.txt",
        lexicon=f"{d}/lexicon-us-en.txt", data_dir=f"{d}/espeak-ng-data", lang="en-us",
    )
    return so.OfflineTts(so.OfflineTtsConfig(model=so.OfflineTtsModelConfig(kokoro=kokoro, num_threads=THREADS)))


RATE = 16000  # of the audio to transcribe
# A stretch still open is heard in pieces, so that each hearing takes about as long however long the
# stretch is: once the open piece is longer than PIECE + SETTLE seconds, it is cut at its quietest
# point between two words at least SETTLE seconds back, whose words are then final. The next piece is
# heard after CONTEXT seconds before the cut, whose words are dropped, so that it is heard in context.
# A hearing takes at least SHORTEST seconds, as far as the stretch reaches back, since Parakeet
# misses words in a short one. A stretch's end is heard the same way, as its last piece: as few words
# are wrong as when it is heard whole, and the hearing is short, so its words come soon after it ends.
PIECE, SETTLE, CONTEXT, SHORTEST = 1.5, 0.5, 1.5, 3.0


def pcm(payload):
    with wave.open(io.BytesIO(payload)) as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, RATE):
            raise ValueError("expected a WAV of 16-bit mono PCM at 16 kHz")
        return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768


def heard(recognizer, audio, at):
    """The words in the audio, timed in seconds from `at`, where the audio starts."""
    stream = recognizer.create_stream()
    stream.accept_waveform(RATE, audio)
    recognizer.decode_stream(stream)
    result = stream.result
    # A token that starts with a space starts a word; the others, such as punctuation, continue it.
    words = []
    for token, start, duration in zip(result.tokens, result.timestamps, result.durations, strict=True):
        if token.startswith(" ") or not words:
            words.append({"text": token.strip(), "start": at + start, "end": at + start + duration})
        else:
            words[-1]["text"] += token
            words[-1]["end"] = at + start + duration
    return words


def quietest(audio, spans, window=int(0.06 * RATE), hop=int(0.01 * RATE)):
    """The sample at the middle of the quietest window inside one of the spans, by energy."""
    best, at = None, None
    for lo, hi in spans:
        width = min(window, hi - lo)
        for start in range(lo, max(lo, hi - width) + 1, hop):
            energy = float(np.mean(audio[start:start + width] ** 2)) if width > 0 else 0.0
            if best is None or energy < best:
                best, at = energy, start + width // 2
    return at


class Stretch:
    """A stretch being transcribed as its audio comes: the audio so far, where its open piece starts,
    the words before that, which are final, and where the stretch ends, once it is known."""

    def __init__(self):
        self.audio, self.cut, self.final, self.end = np.zeros(0, np.float32), 0, [], None
        self.touched = time.monotonic()

    def add(self, audio, end):
        self.audio = np.concatenate([self.audio, audio])
        if end is not None:
            self.end = round(end * RATE)
        self.touched = time.monotonic()

    def words(self, recognizer):
        """Its words so far, in seconds into its audio; cuts the open piece once it is long enough."""
        audio = self.audio[:self.end]
        start = max(0, min(self.cut - round(CONTEXT * RATE), len(audio) - round(SHORTEST * RATE)))
        words = stitched(self.final, heard(recognizer, audio[start:], start / RATE), start / RATE, self.cut / RATE)
        if self.end is None and len(audio) - self.cut >= (PIECE + SETTLE) * RATE:
            lo, hi = self.cut + round(PIECE / 2 * RATE), len(audio) - round(SETTLE * RATE)
            gaps = [(max(lo, round(a["end"] * RATE)), min(hi, round(b["start"] * RATE))) for a, b in zip(words, words[1:])]
            self.cut = quietest(audio, [g for g in gaps if g[1] >= g[0]] or [(lo, hi)])
            self.final = [w for w in words if middle(w) < self.cut / RATE]
        return words


def middle(word):
    return (word["start"] + word["end"]) / 2


def stitched(before, piece, start, cut):
    """The words `before` a cut, and those of the `piece` heard from `start` on, which reaches back
    across the cut at `cut`. The two hearings overlap in between, and are split at a word both heard,
    the one nearest the middle of the overlap, where each is farthest from the edge of its audio;
    where there is none, at the cut."""
    key = lambda w: "".join(c for c in w["text"].lower() if c.isalnum())
    first = next((i for i, w in enumerate(before) if w["end"] > start), len(before))
    last = next((j for j, w in enumerate(piece) if middle(w) >= cut), len(piece))
    a, b = [key(w) for w in before[first:]], [key(w) for w in piece[:last]]
    pairs = [(first + m.a + k, m.b + k) for m in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks()
             for k in range(m.size) if a[m.a + k]]
    if not pairs:
        return before + piece[last:]
    i, j = min(pairs, key=lambda p: abs(middle(before[p[0]]) - (start + cut) / 2))
    return before[:i + 1] + piece[j + 1:]


def transcript(words):
    words = [{**w, "start": round(w["start"], 2), "end": round(w["end"], 2)} for w in words]
    return json.dumps({"text": " ".join(w["text"] for w in words), "words": words}).encode()


def synthesize(tts, payload):
    request = json.loads(payload)
    voice = request.get("voice", VOICE)
    if voice not in VOICES:
        raise ValueError(f"no voice {voice!r}")
    audio = tts.generate(request["text"], sid=VOICES.index(voice), speed=1.0)
    pcm = (np.clip(np.asarray(audio.samples), -1, 1) * 32767).astype(np.int16)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(audio.sample_rate)
        w.writeframes(pcm.tobytes())
    return out.getvalue()


class Session:
    def __init__(self, link, name):
        query = urllib.parse.urlencode({"as": name})
        joined = json.loads(self.request(f"{link}/join?{query}", b""))
        self.me, self.read = joined["link"], joined["n"]
        log(f"joined as {name}")

    @staticmethod
    def request(url, data=None, type=None, timeout=30):
        headers = {"Content-Type": type} if type else {}
        with urllib.request.urlopen(urllib.request.Request(url, data, headers), timeout=timeout) as response:
            return response.read()

    def send(self, type, payload):
        self.request(self.me, payload, PREFIX + type)

    def receive(self):
        """The entries after the last one received, waiting up to a minute for one."""
        lines = self.request(f"{self.me}?after={self.read}&wait=60", timeout=90).decode().splitlines()
        entries = [json.loads(line) for line in lines[:-1]]
        if entries:
            self.read = entries[-1]["n"]
        return entries

    def payload(self, n):
        return self.request(f"{self.me}/{n}")

    def leave(self):
        self.request(f"{self.me}/leave", b"")
        log("left")


def main():
    if len(sys.argv) not in (2, 3):
        raise SystemExit(__doc__)
    link, name = sys.argv[1].rstrip("/"), sys.argv[2] if len(sys.argv) == 3 else "engine"

    def stop(*_):
        STOPPING.set()
        sys.exit(0)

    # SIGINT too, which a shell leaves ignored for a command it runs in the background.
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    session = Session(link, name)
    try:
        serve(session)
    finally:
        try:
            session.leave()
        except OSError:
            pass


def serve(session):
    def status(text):
        log(text)
        try:
            session.send("status+json", json.dumps({"text": text}).encode())
        except OSError as error:
            log(f"couldn't send the status: {error}")

    progress, fetched = Progress(), threading.Event()
    if not all((CACHE / model).exists() for model in MODELS):
        status("Fetching the models, about 1 GB, once.")

        def report():
            while not fetched.wait(10):
                status(f"Fetching the models: {progress}.")

        threading.Thread(target=report, daemon=True).start()
    with ThreadPoolExecutor(2) as pool:
        asr, tts = pool.map(lambda model: fetch(model, progress), ["parakeet", "kokoro"])
    fetched.set()
    status("Loading the models.")
    recognizer, tts = transcriber(asr), synthesizer(tts)

    def answer(type, n, payload):
        try:
            session.send(f"{type}; of={n}", payload)
        except OSError as error:
            log(f"couldn't answer entry {n}: {error}")

    def failed(n, error):
        answer("failed+json", n, json.dumps({"error": str(error)}).encode())

    # One worker each, so that a transcript never waits for speech, nor speech for a transcript.
    speaking, hearing = queue.Queue(), queue.Queue()

    def speak():
        while True:
            n = speaking.get()
            try:
                payload = synthesize(tts, session.payload(n))
            except Exception as error:
                failed(n, error)
            else:
                answer("speech", n, payload)

    def hear():
        # The stretches answered in full, or failed, whose later entries are skipped.
        stretches, done = {}, set()
        while True:
            # All the audio that came is taken at once, so that a hearing that fell behind catches up.
            batch = [hearing.get()]
            while not hearing.empty():
                batch.append(hearing.get())
            touched = []
            for n, of, end in batch:
                key = of or n
                if key in done:
                    continue
                if of is not None and of not in stretches:
                    done.add(of)
                    failed(of, "the start of the stretch never came")
                    continue
                try:
                    stretches.setdefault(key, Stretch()).add(pcm(session.payload(n)), end)
                except Exception as error:
                    done.add(key)
                    stretches.pop(key, None)
                    failed(key, error)
                    continue
                if key not in touched:
                    touched.append(key)
            for key in touched:
                stretch = stretches[key]
                try:
                    words = stretch.words(recognizer)
                except Exception as error:
                    del stretches[key]
                    failed(key, error)
                    continue
                if stretch.end is None:
                    answer("transcript+json; partial", key, transcript(words))
                else:
                    del stretches[key]
                    done.add(key)
                    answer("transcript+json", key, transcript(words))
            # A stretch whose end never came, such as of a page that closed.
            for key in [k for k, s in stretches.items() if time.monotonic() - s.touched > 60]:
                del stretches[key]

    threading.Thread(target=speak, daemon=True).start()
    threading.Thread(target=hear, daemon=True).start()
    session.send("offer+json", json.dumps({
        "transcription": "parakeet-tdt-0.6b-v2-int8",
        "synthesis": "kokoro-v1.0",
        "voices": [VOICE, *(voice for voice in VOICES if voice != VOICE)],
        "source": SOURCE,
    }).encode())
    log("offered; converting until stopped")

    while True:
        try:
            entries = session.receive()
        except urllib.error.HTTPError as error:
            if error.code in (403, 404, 410):
                raise SystemExit(f"the session is gone for the engine: {error.code} {error.read().decode().strip()}") from None
            time.sleep(1)
            continue
        except OSError:
            time.sleep(1)
            continue
        for entry in entries:
            type, *params = (part.strip() for part in entry["type"].split(";"))
            params = dict(param.partition("=")[::2] for param in params)
            if type == PREFIX + "synthesize+json":
                speaking.put(entry["n"])
            elif type == PREFIX + "transcribe":
                try:
                    of = int(params["of"]) if "of" in params else None
                    end = float(params["end"]) if "end" in params else None
                except ValueError:
                    failed(entry["n"], "of and end must be numbers")
                    continue
                hearing.put((entry["n"], of, end))


if __name__ == "__main__":
    main()
