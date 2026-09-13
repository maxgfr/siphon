# One image that serves both halves: the API and the static frontend. That makes
# `docker run` a complete, working product — and it sidesteps CORS and
# mixed-content entirely, since the page and the API share an origin.
FROM python:3.12-slim

# ffmpeg is not optional: without it yt-dlp cannot merge separate video/audio
# streams (so "best quality" fails) and cannot convert audio at all.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ ./server/
COPY web/ ./web/

ENV WEB_DIR=/app/web \
    DOWNLOAD_DIR=/tmp/yt-dlp-web \
    PORT=8000 \
    PYTHONUNBUFFERED=1

# Downloads are written here; keeping it a volume stops a long session from
# growing the container's writable layer.
VOLUME ["/tmp/yt-dlp-web"]

EXPOSE 8000

# Non-root: this process runs a downloader against URLs strangers can supply.
RUN useradd --create-home --uid 10001 app && mkdir -p /tmp/yt-dlp-web && chown -R app /tmp/yt-dlp-web
USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",8000)}/api/health').read()" || exit 1

CMD ["sh", "-c", "uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
