# NicotinD analysis sidecar — Essentia-TensorFlow embeddings + tagging heads.
# CPU by default; `--build-arg GPU=1` swaps in Google's GPU libtensorflow (the
# SAME 2.5.0 version the essentia wheel bundles) + the CUDA-11 runtime wheels.
# The GPU image keeps FULL CPU fallback: TF dlopens its CUDA libs instead of
# linking them, so with no GPU/driver at runtime it silently runs on CPU.
# See docs/audio-ml-enrichment.md.
FROM python:3.11-slim

ARG GPU=0

# ffmpeg does ALL audio decoding (essentia's bundled AudioLoader lacks Opus —
# the library's standard codec — see app/models.py load_audio).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Pinned model set (~27 MB). URLs + SHA256 verified 2026-07; stems double as the
# modelVersions reported by /health, and the golden tests anchor on them.
RUN set -eux; \
    mkdir -p /models; cd /models; \
    base_fe="https://essentia.upf.edu/models/feature-extractors"; \
    base_ch="https://essentia.upf.edu/models/classification-heads"; \
    dl() { python -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" "$1" "$2"; }; \
    dl "$base_fe/discogs-effnet/discogs-effnet-bs64-1.pb"                  discogs-effnet-bs64-1.pb; \
    dl "$base_fe/musicnn/msd-musicnn-1.pb"                                 msd-musicnn-1.pb; \
    dl "$base_ch/danceability/danceability-discogs-effnet-1.pb"            danceability-discogs-effnet-1.pb; \
    dl "$base_ch/mood_happy/mood_happy-discogs-effnet-1.pb"                mood_happy-discogs-effnet-1.pb; \
    dl "$base_ch/mood_sad/mood_sad-discogs-effnet-1.pb"                    mood_sad-discogs-effnet-1.pb; \
    dl "$base_ch/mood_aggressive/mood_aggressive-discogs-effnet-1.pb"      mood_aggressive-discogs-effnet-1.pb; \
    dl "$base_ch/mood_relaxed/mood_relaxed-discogs-effnet-1.pb"            mood_relaxed-discogs-effnet-1.pb; \
    dl "$base_ch/mood_party/mood_party-discogs-effnet-1.pb"                mood_party-discogs-effnet-1.pb; \
    dl "$base_ch/mood_acoustic/mood_acoustic-discogs-effnet-1.pb"          mood_acoustic-discogs-effnet-1.pb; \
    dl "$base_ch/voice_instrumental/voice_instrumental-discogs-effnet-1.pb" voice_instrumental-discogs-effnet-1.pb; \
    dl "$base_ch/emomusic/emomusic-msd-musicnn-2.pb"                       emomusic-msd-musicnn-2.pb; \
    dl "$base_ch/genre_discogs400/genre_discogs400-discogs-effnet-1.pb"    genre_discogs400-discogs-effnet-1.pb; \
    printf '%s\n' \
      "3ed9af50d5367c0b9c795b294b00e7599e4943244f4cbd376869f3bfc87721b1  discogs-effnet-bs64-1.pb" \
      "cdea0722bcee7f731286843f2233e3aa69887bb5c3e2dce011eff55f38d04f3e  msd-musicnn-1.pb" \
      "e1251f02cdc846445e2bc1fb3fe9963e32728c5c000e009188ae47c8963cb4c4  danceability-discogs-effnet-1.pb" \
      "de322aee7f4da29ecbd149c86e7964bd6fabe41ca85698a0be40a39d49e88633  mood_happy-discogs-effnet-1.pb" \
      "4865cba49968b6ec295db3e8af6b4a7bb506b1a646628b9f07ee9910d52df82c  mood_sad-discogs-effnet-1.pb" \
      "7705284e3a67f23f04d3f2fd75e18a82c0e70db8875b7b6f7061f2432de80858  mood_aggressive-discogs-effnet-1.pb" \
      "2c5aa6666b58fe80429a2dc677a135e9995922889b5a399af87d1c15f0ebb71d  mood_relaxed-discogs-effnet-1.pb" \
      "bbd773a27002978179dd6fc5ffb75b7c41e6a7e412b5c5254d51a025e5b9373e  mood_party-discogs-effnet-1.pb" \
      "96a48d403f52fe9047214437fe396dd2f46699da765c911cd6dfbd456a20f733  mood_acoustic-discogs-effnet-1.pb" \
      "c8033548e17c292874265db62e82a051247768d10375a35a769e7bf695f16acf  voice_instrumental-discogs-effnet-1.pb" \
      "fcfb486510213b35e0a691975325f58170f648ad4a02d749bce790da13ded43b  emomusic-msd-musicnn-2.pb" \
      "3885ba078a35249af94b8e5e4247689afac40deca4401a4bc888daf5a579c01c  genre_discogs400-discogs-effnet-1.pb" \
      > SHA256SUMS; \
    sha256sum -c SHA256SUMS

WORKDIR /srv/analysis
COPY pyproject.toml ./
COPY app ./app
RUN if [ "$GPU" = "1" ]; then pip install --no-cache-dir '.[models,gpu]'; \
    else pip install --no-cache-dir '.[models]'; fi

# GPU=1: replace the wheel's vendored CPU libtensorflow with Google's official
# GPU build of the same version. The essentia extension links the vendored file
# by its auditwheel-mangled name (RPATH $ORIGIN/../essentia_tensorflow.libs),
# so the GPU .so is dropped in UNDER THAT EXACT NAME; its libtensorflow_framework
# dependency lands alongside (resolved through the extension's inherited RPATH).
RUN set -eux; \
    if [ "$GPU" = "1" ]; then \
      libs_dir="$(python -c 'import pathlib, essentia; print(pathlib.Path(essentia.__file__).resolve().parent.parent / "essentia_tensorflow.libs")')"; \
      vendored="$(ls "$libs_dir"/libtensorflow-*.so.2.5.0)"; \
      python -c "import urllib.request; urllib.request.urlretrieve('https://storage.googleapis.com/tensorflow/libtensorflow/libtensorflow-gpu-linux-x86_64-2.5.0.tar.gz', '/tmp/tf-gpu.tar.gz')"; \
      echo "2261c4d315432fde9df1cb52de5ea088b6bc904d343c6d38d613555dc66c8665  /tmp/tf-gpu.tar.gz" | sha256sum -c; \
      tar -xzf /tmp/tf-gpu.tar.gz -C /tmp ./lib/libtensorflow.so.2.5.0 ./lib/libtensorflow_framework.so.2.5.0; \
      mv /tmp/lib/libtensorflow.so.2.5.0 "$vendored"; \
      mv /tmp/lib/libtensorflow_framework.so.2.5.0 "$libs_dir/libtensorflow_framework.so.2"; \
      rm -rf /tmp/tf-gpu.tar.gz /tmp/lib; \
    fi

# ANALYSIS_GPU_BUILD feeds runtime_device() (an honest "gpu" only when the swap
# happened AND a driver is visible). LD_LIBRARY_PATH exposes the pip CUDA libs
# TF dlopens; the dirs simply don't exist in the CPU image, which is harmless.
# TF_FORCE_GPU_ALLOW_GROWTH stops TF from grabbing all GPU memory up front
# (the card may be shared with other workloads).
ENV ANALYSIS_MODELS_DIR=/models \
    MUSIC_DIR=/data/music \
    ANALYSIS_GPU_BUILD=$GPU \
    TF_FORCE_GPU_ALLOW_GROWTH=true \
    LD_LIBRARY_PATH=/usr/local/lib/python3.11/site-packages/nvidia/cuda_runtime/lib:/usr/local/lib/python3.11/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.11/site-packages/nvidia/cufft/lib:/usr/local/lib/python3.11/site-packages/nvidia/curand/lib:/usr/local/lib/python3.11/site-packages/nvidia/cusolver/lib:/usr/local/lib/python3.11/site-packages/nvidia/cusparse/lib:/usr/local/lib/python3.11/site-packages/nvidia/cudnn/lib:/usr/local/lib/python3.11/site-packages/nvidia/cuda_nvrtc/lib

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if b'ok' in urllib.request.urlopen('http://localhost:8000/health', timeout=4).read() else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
