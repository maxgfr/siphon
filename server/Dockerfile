# One image that serves both halves: the API and the static frontend. That makes
# `docker run` a complete, working product — and it sidesteps CORS and
# mixed-content entirely, since the page and the API share an origin.
FROM python:3.12-slim

# ffmpeg is not optional: without it yt-dlp cannot merge separate video/audio
# streams (so "best quality" fails) and cannot convert audio at all.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# A JavaScript runtime is not optional either, since late 2025: YouTube's
# signature challenge is solved by running its own player script, and yt-dlp
# does that with an external runtime — Deno by default — plus the solver
# scripts that ship in the yt-dlp[default] extras. Without the runtime it
# warns that YouTube extraction is deprecated and formats go missing. The
# official image publishes the bare binary for amd64 and arm64.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app

COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# The proof-of-origin plugin. Installed unconditionally but inert unless
# POT_PROVIDER_URL points at a running provider (docker-compose.potoken.yml),
# so the image is ready for the hardest YouTube cases without requiring the
# sidecar for the easy ones.
RUN pip install --no-cache-dir bgutil-ytdlp-pot-provider

COPY server/ ./server/
COPY web/ ./web/
# The converter beside the page, so the image needs no CDN at first use.
COPY scripts/vendor_ffmpeg.py ./scripts/vendor_ffmpeg.py
RUN python scripts/vendor_ffmpeg.py

ENV WEB_DIR=/app/web \
    DOWNLOAD_DIR=/tmp/siphon \
    COOKIES_FILE=/tmp/siphon/cookies.txt \
    PORT=8000 \
    PYTHONUNBUFFERED=1

# Downloads are written here; keeping it a volume stops a long session from
# growing the container's writable layer.
VOLUME ["/tmp/siphon"]

EXPOSE 8000

# Non-root: this process runs a downloader against URLs strangers can supply.
RUN useradd --create-home --uid 10001 app && mkdir -p /tmp/siphon && chown -R app /tmp/siphon
USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",8000)}/api/health').read()" || exit 1

CMD ["sh", "-c", "uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
