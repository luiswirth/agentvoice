#!/usr/bin/env bash
# Makes a Moonshine Streaming checkpoint from Hugging Face into the files
# moonshine-wasm loads, with Moonshine's own export and quantization:
#
#   moonshine-export.sh <sources> <repository> <revision> <output>
#
# <sources> is where Moonshine's repository is cloned, pinned below.
set -euo pipefail
sources=$1 repository=$2 revision=$3 output=$4
MOONSHINE=234f60faa0eb388b01cdf7e60aca232af37aefda

# Only its scripts are needed, not the binaries it keeps in Git LFS.
export GIT_LFS_SKIP_SMUDGE=1
test -d "$sources" || git clone -q https://github.com/moonshine-ai/moonshine "$sources"
git -C "$sources" checkout -q "$MOONSHINE"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Moonshine's scripts call python3, so it is one with their packages.
export UV_INDEX_STRATEGY=unsafe-best-match
mkdir "$work/bin"
cat >"$work/bin/python3" <<EOF
#!/bin/sh
exec nix shell nixpkgs#uv -c uv run -q --python 3.12 \
	--index https://download.pytorch.org/whl/cpu --with torch --with 'transformers>=5.15' \
	--with onnx --with onnxscript --with onnxruntime --with onnx-shrink-ray \
	--with safetensors --with huggingface_hub python "\$@"
EOF
chmod +x "$work/bin/python3"
export PATH="$work/bin:$PATH"

cd "$work"
checkpoint=$(python3 -c 'import sys; from huggingface_hub import snapshot_download
print(snapshot_download(sys.argv[1], revision=sys.argv[2]))' "$repository" "$revision")
python3 "$sources/language-bindings/python/src/moonshine_voice/lora/export.py" \
	--model "$checkpoint" --output-dir . >/dev/null
cp "$checkpoint/tokenizer.json" .
python3 -I "$sources/scripts/convert_tokenizer.py" tokenizer.json tokenizer.bin >/dev/null
bash "$sources/scripts/quantize-streaming-model.sh" . >/dev/null 2>&1
# moonshine-wasm 0.1.5 loads one frontend.ort, from before the frontend's
# weights were split off.
python3 -m onnxruntime.tools.convert_onnx_models_to_ort frontend_quantized_weights.onnx >/dev/null
mv frontend_quantized_weights.ort frontend.ort

mkdir -p "$output"
cp frontend.ort encoder.ort adapter.ort cross_kv.ort decoder_kv.ort \
	streaming_config.json tokenizer.bin "$output/"
