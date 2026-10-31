# /// script
# requires-python = ">=3.12"
# dependencies = ["sherpa-onnx==1.12.40", "numpy==2.3.4"]
# ///
# sherpa-onnx 2.0 drops the words Kokoro's lexicon lacks, such as numbers, rather than spelling them out.
"""Voice's engine: a participant of a polylogue session that transcribes and speaks.

    uv run engine.py <session link> [name]

It speaks the engine extension, https://voice.agentics.lwirth.com/engine.md:
it transcribes with NVIDIA's Parakeet v2 and speaks with Kokoro v1.0,
both in k2-fsa's conversions for sherpa-onnx, fetched once from k2-fsa's releases
and checked against the hashes below.
It reaches only the session and those releases, keeps nothing but the models,
in ~/.cache/polylogue-voice-engine, and runs no commands.
It runs until stopped, and then leaves the session.
"""

import hashlib, io, json, os, queue, signal, sys, tarfile, threading, time, wave
import urllib.parse, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import sherpa_onnx as so

RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
MODELS = {
    "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8": (
        f"{RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
        "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
    ),
    "kokoro-multi-lang-v1_0": (
        f"{RELEASES}/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
        "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4",
    ),
}
VOICE = 3  # Kokoro's af_heart
SOURCE = "https://github.com/luiswirth/polylogue-voice/blob/main/engine/engine.py"
PREFIX = "application/vnd.polylogue.engine."
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "polylogue-voice-engine"
THREADS = min(4, os.cpu_count() or 1)


def log(message):
    print(message, file=sys.stderr, flush=True)


class Hashing(io.RawIOBase):
    """A download read as a stream, hashed as it passes."""

    def __init__(self, response):
        self.response, self.hash = response, hashlib.sha256()

    def readable(self):
        return True

    def readinto(self, buffer):
        data = self.response.read(len(buffer))
        self.hash.update(data)
        buffer[: len(data)] = data
        return len(data)


def fetch(name):
    """The model's directory, downloaded, checked and unpacked on first use."""
    target = CACHE / name
    if target.exists():
        return target
    url, digest = MODELS[name]
    partial = CACHE / f"{name}.partial"
    partial.mkdir(parents=True, exist_ok=True)
    log(f"fetching {url}")
    with urllib.request.urlopen(url) as response:
        stream = Hashing(response)
        with tarfile.open(fileobj=stream, mode="r|bz2") as archive:
            archive.extractall(partial, filter="data")
        while stream.read(1 << 20):
            pass
    if stream.hash.hexdigest() != digest:
        raise SystemExit(f"{url} doesn't match its hash: not used")
    (partial / name).rename(target)
    partial.rmdir()
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
        asr, tts = pool.map(fetch, ["sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "kokoro-multi-lang-v1_0"])
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
