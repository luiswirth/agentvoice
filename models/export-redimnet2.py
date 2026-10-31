# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["torch==2.15.0", "torchaudio==2.11.1", "onnx==1.23.2", "onnxruntime==1.31.1", "numpy==2.3.4", "scipy==1.18.1"]
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# torchaudio = { index = "pytorch-cpu" }
# ///
"""Exports the voice fingerprint, ReDimNet2 b3 trained on VoxBlink2, VoxCeleb2
and CN-Celeb, to ONNX, with its mel front end inside, so that it takes the raw
16 kHz waveform [1, T] and gives a 192-dimensional embedding, compared by cosine.

    uv run models/export-redimnet2.py

It fetches the code from PalabraAI/redimnet2 (MIT) at a pinned commit, and the
weights from its release v1.0.0, checked against their hash, and writes
public/models/redimnet2-b3-vb2-vox2-cnc2-lm.onnx, which the page serves and
pins by its own hash (src/voice/models.ts). It checks the export against
PyTorch on random audio.
"""

import hashlib, sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

COMMIT = "c5bbe0b76e37df698c403f8844e41304ceab6307"
WEIGHTS = "b3-vb2+vox2+cnc2_v0-lm.pt"
WEIGHTS_SHA256 = "b64989536ef8822447d72517ad9019b870a951e85a3f176f0ed42d2a4c3d811d"
OUT = Path(__file__).resolve().parent.parent / "public/models/redimnet2-b3-vb2-vox2-cnc2-lm.onnx"


def main():
    # Fetched and checked before the code loads it from torch's cache.
    weights = Path(torch.hub.get_dir()) / "checkpoints" / WEIGHTS
    if not weights.exists():
        weights.parent.mkdir(parents=True, exist_ok=True)
        torch.hub.download_url_to_file(
            f"https://github.com/PalabraAI/redimnet2/releases/download/v1.0.0/{WEIGHTS}", str(weights))
    if hashlib.sha256(weights.read_bytes()).hexdigest() != WEIGHTS_SHA256:
        sys.exit(f"{weights} doesn't match its hash")
    model = torch.hub.load(
        f"PalabraAI/redimnet2:{COMMIT}", "redimnet2", model_name="b3",
        train_type="lm", dataset="vb2+vox2+cnc2_v0", trust_repo=True,
    ).eval()
    torch.onnx.export(
        model, (torch.randn(1, 32000) * 0.1,), str(OUT),
        input_names=["wave"], output_names=["embedding"],
        dynamic_axes={"wave": {1: "t"}}, opset_version=17, dynamo=False,
    )
    session = ort.InferenceSession(str(OUT), providers=["CPUExecutionProvider"])
    for n in (16000, 48000):
        x = torch.randn(1, n) * 0.1
        with torch.no_grad():
            want = model(x).numpy()[0]
        got = session.run(None, {"wave": x.numpy()})[0][0]
        print(f"{n / 16000:.0f} s: cos(torch, onnx) = {want @ got / np.linalg.norm(want) / np.linalg.norm(got):.6f}")
    print(OUT.name, hashlib.sha256(OUT.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
