# NicotinD analysis sidecar — Essentia-TensorFlow embeddings + tagging heads.
# CPU-first (the essentia-tensorflow wheel bundles CPU libtensorflow); for the
# GPU upgrade path see docs/audio-ml-enrichment.md.
FROM python:3.11-slim

# ffmpeg does ALL audio decoding (essentia's bundled AudioLoader lacks Opus —
# the library's standard codec — see app/models.py load_audio).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Pinned model set (~25 MB). URLs + SHA256 verified 2026-07; stems double as the
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
      > SHA256SUMS; \
    sha256sum -c SHA256SUMS

WORKDIR /srv/analysis
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir '.[models]'

ENV ANALYSIS_MODELS_DIR=/models \
    MUSIC_DIR=/data/music

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if b'ok' in urllib.request.urlopen('http://localhost:8000/health', timeout=4).read() else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
