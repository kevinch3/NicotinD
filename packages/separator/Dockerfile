# NicotinD vocal-separation sidecar — BS-RoFormer instrumental stems for karaoke.
# GPU-only by contract: CPU inference measured at RTF 4.1x (~14 min per song), so
# the app reports `unavailable` without CUDA (app/main.py). `--build-arg GPU=0`
# builds the CPU-torch variant used ONLY by CI's image smoke build.
# See docs/vocal-separation.md.
FROM python:3.11-slim

ARG GPU=1

# ffmpeg does all decoding (Opus is the library's standard codec; libsndfile
# cannot read it). Also provides ffprobe for the length guard.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Model files, baked at build (204 MB). anvuew/BS-RoFormer, GPL-3.0 — the
# checkpoint the spike measured (docs/vocal-isolation-spike.md §3/§5). SHA256 of
# the checkpoint is the HF LFS digest; config.yaml's was computed 2026-09-02.
RUN set -eux; \
    mkdir -p /models; cd /models; \
    base="https://huggingface.co/anvuew/BS-RoFormer/resolve/main"; \
    dl() { python -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" "$1" "$2"; }; \
    dl "$base/bs_roformer_ft1_anvuew_sdr_12.55.ckpt" bs_roformer_ft1_anvuew_sdr_12.55.ckpt; \
    dl "$base/config.yaml"                          config.yaml; \
    printf '%s\n' \
      "60347271e8493fdff28ef558c3b2297afb869a1f4462594ed548038264bec395  bs_roformer_ft1_anvuew_sdr_12.55.ckpt" \
      "033e57abee226a480ef410e0631b9fe00e8b7bc9a3bb5fe55659d0b43a238701  config.yaml" \
      > SHA256SUMS; \
    sha256sum -c SHA256SUMS

WORKDIR /srv/separator
# Dependency layer first, from pyproject alone (a stub package stands in for
# the real sources), so an edit under app/ never re-downloads the ~3 GB of
# torch + CUDA wheels below. The real app is copied and installed --no-deps
# at the end.
COPY pyproject.toml requirements-torch-cu126.txt requirements-torch-cpu.txt ./
RUN mkdir -p app && touch app/__init__.py

# torch FIRST, from the pinned PyTorch index: cu126 is the "legacy" lane that
# still ships Pascal kernels (sm_60, which the cc 6.1 P4000 runs) — the default
# PyPI wheel is cu128+ and dropped them in torch 2.8. Installing it first means
# bs-roformer's own `torch>=2.0` requirement resolves to this wheel instead of
# pulling another.
RUN set -eux; \
    if [ "$GPU" = "1" ]; then pip install --no-cache-dir -r requirements-torch-cu126.txt; \
    else pip install --no-cache-dir -r requirements-torch-cpu.txt; fi; \
    pip install --no-cache-dir '.[models]'

COPY app ./app
RUN pip install --no-cache-dir --no-deps .

# Pascal guard: refuse to ship a torch build the prod card (Quadro P4000, cc 6.1)
# cannot run. The cu126 wheel ships sm_60 and no sm_61 — that is enough, because
# SASS is forward-compatible within a major version (app/device.py
# arch_supported); asserting the literal 'sm_61' failed on the very card this
# protects.
RUN if [ "$GPU" = "1" ]; then \
      python -c "import torch; from app.device import arch_supported; a = torch.cuda.get_arch_list(); assert arch_supported((6, 1), a), a; print('cuda archs', a)"; \
    fi

# Build-time contract check, on CPU: the pinned bs-roformer must import against
# this torch, accept the (filtered) config, and strict-load the checkpoint with
# 0 missing / 0 unexpected tensors. A pin drift fails the image build here, not
# the first karaoke play in prod.
RUN python -c "from app.model import load_model; m, cfg = load_model('/models', 'cpu'); print('checkpoint ok:', sum(p.numel() for p in m.parameters()) // 1_000_000, 'M params')"

ENV SEPARATOR_MODELS_DIR=/models \
    MUSIC_DIR=/data/music \
    SEPARATOR_GPU_BUILD=$GPU

EXPOSE 8000
# Match the exact JSON so a body that merely *contains* "ok" (e.g. a reason
# string) can never pass — the analysis image's substring grep is looser.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if b'\"status\":\"ok\"' in urllib.request.urlopen('http://localhost:8000/health', timeout=4).read() else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
