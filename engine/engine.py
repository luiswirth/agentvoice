# /// script
# requires-python = ">=3.12"
# dependencies = ["sherpa-onnx==1.12.40", "numpy==2.3.4"]
# ///
# sherpa-onnx 2.0 drops the words Kokoro's lexicon lacks, such as numbers, rather than spelling them out.
"""Voice's engine: a participant of a polylogue session that transcribes and speaks.

    uv run engine.py <session link> [name]

It speaks the engine extension, https://voice.agentics.lwirth.com/engine.md:
it transcribes with NVIDIA's Parakeet v2 and speaks with Kokoro v1.0,
both in k2-fsa's conversions for sherpa-onnx, fetched once from Hugging Face at pinned revisions
and checked against the hashes below.
It reaches only the session and Hugging Face, keeps nothing but the models,
in ~/.cache/polylogue-voice-engine, and runs no commands.
It runs until stopped, and then leaves the session.
"""

import hashlib, io, json, os, queue, shutil, signal, sys, tempfile, threading, time, wave
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
VOICE = 3  # Kokoro's af_heart
SOURCE = "https://github.com/luiswirth/polylogue-voice/blob/main/engine/engine.py"
PREFIX = "application/vnd.polylogue.engine."
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "polylogue-voice-engine"
THREADS = min(4, os.cpu_count() or 1)


def log(message):
    print(message, file=sys.stderr, flush=True)


def download(url, path, attempts=4):
    """The file's sha256, once it is written to the path, trying again where the connection fails."""
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(attempts):
        hash = hashlib.sha256()
        try:
            with urllib.request.urlopen(url, timeout=60) as response, open(path, "wb") as file:
                while data := response.read(1 << 20):
                    hash.update(data)
                    file.write(data)
            return hash.hexdigest()
        except OSError as error:
            if attempt == attempts - 1:
                raise SystemExit(f"couldn't fetch {url}: {error}") from None
            time.sleep(2**attempt)


def fetch(name):
    """The model's directory, downloaded and checked on first use."""
    target = CACHE / name
    if target.exists():
        return target
    repo, revision, wanted, digest = MODELS[name]
    log(f"fetching https://huggingface.co/{repo}/tree/{revision}")
    with urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}/tree/{revision}?recursive=true") as response:
        tree = json.load(response)
    paths = sorted(entry["path"] for entry in tree if entry["type"] == "file"
                   and any(entry["path"] == w or w.endswith("/") and entry["path"].startswith(w) for w in wanted))
    # A directory of this run's own, so that engines started together never touch each other's download.
    CACHE.mkdir(parents=True, exist_ok=True)
    partial = Path(tempfile.mkdtemp(dir=CACHE, prefix=f"{name}.partial."))
    try:
        with ThreadPoolExecutor(16) as pool:
            hashes = pool.map(lambda p: download(f"https://huggingface.co/{repo}/resolve/{revision}/{urllib.parse.quote(p)}", partial / p), paths)
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


def transcribe(recognizer, payload):
    with wave.open(io.BytesIO(payload)) as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, 16000):
            raise ValueError("expected a WAV of 16-bit mono PCM at 16 kHz")
        audio = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, audio)
    recognizer.decode_stream(stream)
    result = stream.result
    # A token that starts with a space starts a word; the others, such as punctuation, continue it.
    words = []
    for token, start, duration in zip(result.tokens, result.timestamps, result.durations, strict=True):
        if token.startswith(" ") or not words:
            words.append({"text": token.strip(), "start": round(start, 2), "end": round(start + duration, 2)})
        else:
            words[-1]["text"] += token
            words[-1]["end"] = round(start + duration, 2)
    return "transcript+json", json.dumps({"text": result.text.strip(), "words": words}).encode()


def synthesize(tts, payload):
    text = json.loads(payload)["text"]
    audio = tts.generate(text, sid=VOICE, speed=1.0)
    pcm = (np.clip(np.asarray(audio.samples), -1, 1) * 32767).astype(np.int16)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(audio.sample_rate)
        w.writeframes(pcm.tobytes())
    return "speech", out.getvalue()


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

    with ThreadPoolExecutor(2) as pool:
        asr, tts = pool.map(fetch, ["parakeet", "kokoro"])
    log("loading the models")
    jobs = {
        PREFIX + "transcribe": (transcribe, transcriber(asr)),
        PREFIX + "synthesize+json": (synthesize, synthesizer(tts)),
    }

    session = Session(link, name)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    # One worker per job, so that a transcript never waits for speech, nor speech for a transcript.
    work = {type: queue.Queue() for type in jobs}

    def worker(type):
        convert, model = jobs[type]
        while True:
            n = work[type].get()
            try:
                answer, payload = convert(model, session.payload(n))
            except Exception as error:
                answer, payload = "failed+json", json.dumps({"error": str(error)}).encode()
            try:
                session.send(f"{answer}; of={n}", payload)
            except OSError as error:
                log(f"couldn't answer entry {n}: {error}")

    for type in jobs:
        threading.Thread(target=worker, args=(type,), daemon=True).start()
    session.send("offer+json", json.dumps({
        "transcription": "parakeet-tdt-0.6b-v2-int8",
        "synthesis": "kokoro-v1.0-af_heart",
        "source": SOURCE,
    }).encode())
    log("offered; converting until stopped")

    try:
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
                type = entry["type"].split(";")[0].strip()
                if type in work:
                    work[type].put(entry["n"])
    finally:
        try:
            session.leave()
        except OSError:
            pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
