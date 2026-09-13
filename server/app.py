"""
siphon — the self-hosted half.

A small HTTP wrapper around yt-dlp, meant to sit behind the static frontend in
web/. It exists because a browser tab cannot do this job itself: the media hosts
send no CORS headers, and getting a playable stream URL out of YouTube means
running its signature JavaScript. So the browser asks this service, and this
service runs the real yt-dlp.

Downloads are jobs rather than one long request. A phone on mobile data will
drop a 10-minute HTTP response, and a progress bar is the difference between
"working" and "broken" on a small screen — both need the work to outlive the
request that started it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import re
import shutil
import socket
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Literal
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# --------------------------------------------------------------------- config

# Comma-separated origins, or "*". The frontend is served from GitHub Pages
# while this runs somewhere else entirely, so cross-origin is the normal case,
# not the exception.
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

# Optional shared secret. Unset means open — fine on a LAN or behind Tailscale,
# not fine on a public URL, and the health endpoint reports which one you are in
# so the frontend can warn you.
AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "").strip()

# Where the YouTube session lives, when one has been uploaded. Kept outside the
# per-job directories so the TTL sweep cannot take it with a finished download.
COOKIES_FILE = Path(os.environ.get("COOKIES_FILE", "")) if os.environ.get("COOKIES_FILE") else None

# An optional sidecar that mints YouTube proof-of-origin tokens
# (brainicism/bgutil-ytdlp-pot-provider, port 4416). When set, every extraction
# offers it to the plugin; when unset, nothing changes.
POT_PROVIDER_URL = os.environ.get("POT_PROVIDER_URL", "").strip().rstrip("/")

MAX_CONCURRENT_JOBS = int(os.environ.get("MAX_CONCURRENT_JOBS", "3"))
JOB_TTL_SECONDS = int(os.environ.get("JOB_TTL_SECONDS", str(60 * 60)))
# Opt-in escape hatch for the one legitimate private-address case: pulling from
# something on your own LAN (a NAS, a local media server). It is off by default
# because leaving it on turns this service into an SSRF probe for whoever can
# reach it — see assert_fetchable for what it disables.
ALLOW_PRIVATE_HOSTS = os.environ.get("ALLOW_PRIVATE_HOSTS", "").strip().lower() in ("1", "true", "yes")

DOWNLOAD_ROOT = Path(os.environ.get("DOWNLOAD_DIR", tempfile.gettempdir())) / "siphon"
DOWNLOAD_ROOT.mkdir(parents=True, exist_ok=True)

COOKIES_PATH = COOKIES_FILE or (DOWNLOAD_ROOT.parent / "siphon-cookies.txt")


def have_cookies() -> bool:
    return COOKIES_PATH.exists() and COOKIES_PATH.stat().st_size > 0

# Serve the frontend from the same origin when it is present. That is what makes
# `docker run` a complete product rather than half of one — and it sidesteps
# CORS and mixed-content entirely for people who self-host both halves.
WEB_DIR = Path(os.environ.get("WEB_DIR", Path(__file__).resolve().parent.parent / "web"))

# ------------------------------------------------------------------- presets

# Kept deliberately small. The frontend shows exactly these, and anything not on
# this list cannot be requested — an arbitrary format string from the client
# would be a way to smuggle yt-dlp options through.
PRESETS: dict[str, dict[str, Any]] = {
    "video_best": {
        "label": "Best quality",
        "kind": "video",
        "opts": {"format": "bv*+ba/b", "merge_output_format": "mp4"},
    },
    "video_1080": {
        "label": "1080p",
        "kind": "video",
        "opts": {
            "format": "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
            "merge_output_format": "mp4",
        },
    },
    "video_720": {
        "label": "720p",
        "kind": "video",
        "opts": {
            "format": "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
            "merge_output_format": "mp4",
        },
    },
    "video_480": {
        "label": "480p",
        "kind": "video",
        "opts": {
            "format": "bv*[height<=480]+ba/b[height<=480]/bv*+ba/b",
            "merge_output_format": "mp4",
        },
    },
    "audio_mp3": {
        "label": "MP3",
        "kind": "audio",
        "opts": {
            "format": "ba/b",
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}
            ],
        },
    },
    "audio_m4a": {
        "label": "M4A",
        "kind": "audio",
        "opts": {
            "format": "ba[ext=m4a]/ba/b",
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "m4a", "preferredquality": "0"}
            ],
        },
    },
}

# --------------------------------------------------------- youtube strategy

# What YouTube says when it wants a proof-of-origin token or a login, rather
# than when the video is genuinely gone. Only these are worth a second attempt
# with a different client; retrying "video unavailable" just wastes the user's
# time.
BOT_WALL_MARKERS = (
    "sign in to confirm",
    "not a bot",
    "po_token",
    "po token",
    "proof of origin",
    "failed to extract any player response",
    "requested format is not available",
    "unable to extract player response",
    "this content isn\u2019t available",
)


def is_bot_wall(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in BOT_WALL_MARKERS)


def player_client_chain(has_cookies: bool) -> list[str | None]:
    """
    Which YouTube clients to try, in order. None means "yt-dlp's own default",
    which tracks upstream and is right far more often than anything pinned here.

    The clients YouTube lets through without a token change every few months, so
    this is a fallback ladder rather than a fixed choice: the first rung is
    always whatever yt-dlp currently thinks best.

    Cookies change the ladder. The TV client authenticates differently, and
    pairing it with a logged-in session tends to invalidate that session — so
    when cookies are present it is left out and the web/mobile clients, which do
    use the session, are tried instead.
    """
    if has_cookies:
        return [None, "web_safari", "mweb"]
    return [None, "tv", "web_safari", "android_vr"]


def extractor_args(client: str | None) -> dict[str, Any]:
    args: dict[str, dict[str, list[str]]] = {}
    if client:
        args["youtube"] = {"player_client": [client]}
    if POT_PROVIDER_URL:
        # Read by the bgutil plugin, if it is installed. Harmless when it is not.
        args["youtubepot-bgutilhttp"] = {"base_url": [POT_PROVIDER_URL]}
    return args


# ------------------------------------------------------------ url validation


class UnsafeUrl(ValueError):
    """The URL is syntactically fine but must not be fetched."""


def assert_fetchable(raw: str) -> str:
    """
    Reject anything that is not a public http(s) URL.

    This service fetches URLs chosen by whoever can reach it, which is the
    textbook setup for SSRF: without this check, `http://169.254.169.254/...`
    would hand out the host's cloud credentials, and yt-dlp's `file://` support
    would read local disk. Names are resolved here and every resulting address
    checked, because a public hostname is free to resolve to 127.0.0.1.
    """
    url = (raw or "").strip()
    if not url:
        raise UnsafeUrl("No URL given.")
    if len(url) > 2048:
        raise UnsafeUrl("That URL is too long.")

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise UnsafeUrl("Only http:// and https:// links can be downloaded.")
    if not parsed.hostname:
        raise UnsafeUrl("That URL has no host.")

    if ALLOW_PRIVATE_HOSTS:
        return url

    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror as exc:
        raise UnsafeUrl(f"Could not resolve {parsed.hostname}.") from exc

    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            raise UnsafeUrl("That address is on a private network, so it will not be fetched.")
    return url


# ----------------------------------------------------------------- job model

JobState = Literal["queued", "running", "done", "error"]


@dataclass
class Job:
    id: str
    url: str
    preset: str
    state: JobState = "queued"
    progress: float = 0.0
    speed: float | None = None
    eta: int | None = None
    total_bytes: int | None = None
    title: str | None = None
    thumbnail: str | None = None
    filename: str | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    # Set once the postprocessing step starts, so the UI can stop showing a
    # percentage that has already hit 100 and say "converting" instead.
    stage: str = "starting"
    # Which YouTube client this attempt is using, and how many walls were hit
    # before it. Both are shown, because "retrying with a different client" is
    # far less alarming than a progress bar that silently restarts.
    client: str | None = None
    attempts: int = 0

    @property
    def directory(self) -> Path:
        return DOWNLOAD_ROOT / self.id

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "state": self.state,
            "stage": self.stage,
            "progress": round(self.progress, 3),
            "speed": self.speed,
            "eta": self.eta,
            "totalBytes": self.total_bytes,
            "title": self.title,
            "thumbnail": self.thumbnail,
            "filename": self.filename,
            "error": self.error,
            "client": self.client,
            "attempts": self.attempts,
        }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
RUNNING = threading.Semaphore(MAX_CONCURRENT_JOBS)


def sweep_expired() -> None:
    """Drop finished jobs and their files once they are past the TTL."""
    cutoff = time.time() - JOB_TTL_SECONDS
    with JOBS_LOCK:
        stale = [job for job in JOBS.values() if job.created < cutoff]
        for job in stale:
            JOBS.pop(job.id, None)
    for job in stale:
        shutil.rmtree(job.directory, ignore_errors=True)


# ------------------------------------------------------------------ download


def _hook(job: Job):
    def hook(status: dict[str, Any]) -> None:
        if status.get("status") == "downloading":
            job.stage = "downloading"
            total = status.get("total_bytes") or status.get("total_bytes_estimate")
            done = status.get("downloaded_bytes") or 0
            if total:
                job.total_bytes = int(total)
                job.progress = min(done / total, 1.0)
            job.speed = status.get("speed")
            job.eta = status.get("eta")
        elif status.get("status") == "finished":
            # yt-dlp reports "finished" per stream: with separate video and audio
            # this fires twice, and the merge has not started yet.
            job.progress = 1.0
            job.stage = "processing"

    return hook


def _postprocessor_hook(job: Job):
    def hook(status: dict[str, Any]) -> None:
        if status.get("status") == "started":
            job.stage = "processing"

    return hook


def build_options(job: Job, client: str | None) -> dict[str, Any]:
    preset = PRESETS[job.preset]
    options: dict[str, Any] = {
        # %(title).150B truncates on BYTES, not characters — a CJK title that
        # fits 150 characters can still blow past a 255-byte filesystem limit.
        "outtmpl": str(job.directory / "%(title).150B [%(id)s].%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "restrictfilenames": False,
        "windowsfilenames": True,
        "concurrent_fragment_downloads": 4,
        "retries": 5,
        "fragment_retries": 5,
        "progress_hooks": [_hook(job)],
        "postprocessor_hooks": [_postprocessor_hook(job)],
        **preset["opts"],
    }
    if have_cookies():
        options["cookiefile"] = str(COOKIES_PATH)
    args = extractor_args(client)
    if args:
        options["extractor_args"] = args
    return options


def run_job(job: Job) -> None:
    """
    Run one download to completion, walking the client ladder if YouTube asks
    for a login instead of a video.

    The ladder only advances on a bot wall. Every other failure — a private
    video, a dead link, a missing codec — is final on the first attempt, because
    trying three more clients would just make the user wait three times as long
    for the same answer.
    """
    with RUNNING:
        job.state = "running"
        attempts = player_client_chain(have_cookies())
        last_error: Exception | None = None

        for index, client in enumerate(attempts):
            # Each attempt starts from an empty directory: a previous try can
            # leave a partial file behind, and the "largest file wins" rule
            # below would happily hand it over.
            shutil.rmtree(job.directory, ignore_errors=True)
            job.directory.mkdir(parents=True, exist_ok=True)
            job.progress = 0.0
            job.stage = "starting" if index == 0 else "retrying"
            job.client = client or "default"

            try:
                with yt_dlp.YoutubeDL(build_options(job, client)) as ydl:
                    info = ydl.extract_info(job.url, download=True)
                    if info.get("_type") == "playlist":
                        entries = [e for e in info.get("entries", []) if e]
                        if not entries:
                            raise yt_dlp.utils.DownloadError("That playlist is empty.")
                        info = entries[0]
                    job.title = info.get("title")
                    job.thumbnail = info.get("thumbnail")

                # Trust the directory over yt-dlp's reported path: postprocessors
                # rename the file (.webm -> .mp3) after the info dict is built, so
                # the recorded name is routinely the one that no longer exists.
                files = [p for p in job.directory.iterdir() if p.is_file()]
                if not files:
                    raise FileNotFoundError("yt-dlp produced no file.")
                chosen = max(files, key=lambda p: p.stat().st_size)
                job.filename = chosen.name
                job.progress = 1.0
                job.stage = "ready"
                job.state = "done"
                return
            except Exception as exc:  # noqa: BLE001 — surfaced to the user verbatim
                last_error = exc
                if index + 1 < len(attempts) and is_bot_wall(str(exc)):
                    job.attempts = index + 1
                    continue
                break

        job.state = "error"
        job.stage = "failed"
        job.error = humanize_error(last_error or Exception("The download failed."))


def humanize_error(exc: Exception) -> str:
    """Turn yt-dlp's stderr-shaped messages into something worth showing a user."""
    text = str(exc)
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    text = re.sub(r"^ERROR:\s*", "", text).strip()
    text = re.sub(r";\s*please report this issue.*$", "", text, flags=re.S).strip()

    lowered = text.lower()
    if is_bot_wall(text):
        if have_cookies():
            return (
                "YouTube asked for a login on every client, even with your cookies. They have "
                "probably expired — export them again from a browser where you are signed in. "
                "If this server is in a datacentre, its IP range is the more likely cause."
            )
        return (
            "YouTube asked this server to prove it is not a bot, on every client tried. "
            "Uploading your YouTube cookies in settings is what fixes this: it lets the "
            "download use your own signed-in session."
        )
    if "private video" in lowered:
        return "That video is private."
    if "video unavailable" in lowered:
        return "That video is unavailable."
    if "members-only" in lowered or "this video is available to" in lowered:
        return "That video is members-only."
    if "unsupported url" in lowered:
        return "yt-dlp does not recognise that link."
    if "is not a valid url" in lowered:
        return "That does not look like a link."
    if "ffmpeg" in lowered and "not" in lowered:
        return "ffmpeg is missing on the server, so the streams cannot be merged or converted."
    return text[:400] or "The download failed."


# ---------------------------------------------------------------------- api


class JobRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    preset: str = "video_best"


class ProbeRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """
    Say something once, at boot, if this is running without a key.

    Unset is a perfectly good choice on a laptop or a LAN. It is a bad one the
    moment a tunnel or a port-forward puts the service on the open internet, and
    that step happens elsewhere — so the warning belongs where the process can
    actually be seen starting, rather than in a README nobody re-reads.
    """
    if not AUTH_TOKEN:
        logging.getLogger("uvicorn.error").warning(
            "AUTH_TOKEN is not set: anyone who can reach this server can use it to download. "
            "That is fine on localhost or your own LAN. If you are putting this behind a tunnel "
            "or forwarding a port to it, set AUTH_TOKEN first."
        )
    yield


app = FastAPI(
    title="siphon",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    # What makes "UI on GitHub Pages, yt-dlp on your own machine" work. Browsers
    # allow an HTTPS page to call http://localhost — localhost counts as a
    # secure context — but Chrome additionally guards public-to-private requests
    # behind a Private Network Access preflight, and refuses the request before
    # the server sees it unless the preflight is answered. This grants nothing on
    # its own: the origin check above is still what decides who may call.
    allow_private_network=True,
    # The preflight is cached, so a download does not pay two round trips to a
    # machine that is already on this desk.
    max_age=3600,
)


def check_auth(authorization: str | None) -> None:
    if not AUTH_TOKEN:
        return
    expected = f"Bearer {AUTH_TOKEN}"
    # Constant-time: a plain == leaks the token one character at a time.
    import hmac

    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="This server needs an access key.")


@app.exception_handler(UnsafeUrl)
async def unsafe_url_handler(_request: Request, exc: UnsafeUrl) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def lan_addresses() -> list[str]:
    """
    The addresses this machine is reachable at from the rest of the network.

    Answers the question every self-hoster asks next — "fine, but how do I open
    this on my phone?" — without making them go hunting through ipconfig. Only
    private ranges are returned: a public address here would be an invitation to
    open a port, which is not something this should encourage.
    """
    found: list[str] = []
    try:
        hostname = socket.gethostname()
        candidates = {info[4][0] for info in socket.getaddrinfo(hostname, None, socket.AF_INET)}
    except socket.gaierror:
        candidates = set()

    # getaddrinfo often reports only loopback in a container, so also ask the
    # routing table which address would be used to reach the outside world.
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.168.255.255", 1))
        candidates.add(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()

    for address in sorted(candidates):
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        if parsed.is_private and not parsed.is_loopback and not parsed.is_link_local:
            found.append(address)
    return found


@app.get("/api/health")
async def health(request: Request) -> dict[str, Any]:
    port = request.url.port or (443 if request.url.scheme == "https" else 80)
    return {
        "lanUrls": [f"http://{address}:{port}" for address in lan_addresses()],
        "ok": True,
        "service": "siphon",
        "ytDlpVersion": yt_dlp.version.__version__,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "requiresKey": bool(AUTH_TOKEN),
        "hasCookies": have_cookies(),
        "potProvider": bool(POT_PROVIDER_URL),
        "allowsPrivateHosts": ALLOW_PRIVATE_HOSTS,
        "presets": [{"id": key, "label": value["label"], "kind": value["kind"]} for key, value in PRESETS.items()],
    }


@app.post("/api/probe")
async def probe(body: ProbeRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """Metadata only, no download — what the UI shows while you pick a quality."""
    check_auth(authorization)
    url = assert_fetchable(body.url)

    def extract() -> dict[str, Any]:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True, "skip_download": True}) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        info = await asyncio.wait_for(asyncio.to_thread(extract), timeout=60)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="The site took too long to answer.")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=humanize_error(exc))

    if info.get("_type") == "playlist":
        entries = [e for e in info.get("entries", []) if e]
        if not entries:
            raise HTTPException(status_code=400, detail="That playlist is empty.")
        info = entries[0]

    return {
        "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "extractor": info.get("extractor_key"),
        "isLive": bool(info.get("is_live")),
    }


class CookiesRequest(BaseModel):
    cookies: str = Field(min_length=1, max_length=2_000_000)


def looks_like_cookie_jar(text: str) -> bool:
    """
    Accept a Netscape cookie jar, reject a paste of something else.

    Checked because the usual mistake is pasting a browser's JSON export, or a
    single header value, and the failure that produces later is a bot wall —
    which looks exactly like the problem the cookies were meant to solve.
    """
    if "# Netscape HTTP Cookie File" in text or "# HTTP Cookie File" in text:
        return True
    # Some exporters omit the header, so also accept the row shape itself:
    # domain, flag, path, secure, expiry, name, value — seven tab-separated fields.
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if len(line.split("\t")) >= 7:
            return True
    return False


@app.post("/api/cookies")
async def put_cookies(body: CookiesRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """
    Store a YouTube session for yt-dlp to use.

    This is the thing that actually gets past "Sign in to confirm you're not a
    bot", because it stops the download looking anonymous. It is also the most
    sensitive data this service will ever hold — a session cookie is a logged-in
    account — so it is written owner-only and never read back out over the API.
    """
    check_auth(authorization)
    text = body.cookies.strip()
    if not looks_like_cookie_jar(text):
        raise HTTPException(
            status_code=400,
            detail=(
                "That does not look like a cookies.txt file. Use a browser extension that "
                "exports the Netscape format, not a JSON export."
            ),
        )
    COOKIES_PATH.parent.mkdir(parents=True, exist_ok=True)
    COOKIES_PATH.write_text(text + "\n", encoding="utf-8")
    COOKIES_PATH.chmod(0o600)
    return {"stored": True, "bytes": len(text)}


@app.delete("/api/cookies")
async def drop_cookies(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    check_auth(authorization)
    existed = COOKIES_PATH.exists()
    COOKIES_PATH.unlink(missing_ok=True)
    return {"deleted": existed}


@app.post("/api/jobs")
async def create_job(body: JobRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    check_auth(authorization)
    sweep_expired()

    if body.preset not in PRESETS:
        raise HTTPException(status_code=400, detail=f"Unknown preset: {body.preset}")
    url = assert_fetchable(body.url)

    with JOBS_LOCK:
        active = sum(1 for job in JOBS.values() if job.state in ("queued", "running"))
        if active >= MAX_CONCURRENT_JOBS * 4:
            raise HTTPException(status_code=429, detail="Too many downloads in flight. Try again shortly.")
        job = Job(id=uuid.uuid4().hex[:16], url=url, preset=body.preset)
        JOBS[job.id] = job

    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return job.public()


@app.get("/api/jobs/{job_id}")
async def read_job(job_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    check_auth(authorization)
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="No such download.")
    return job.public()


@app.get("/api/jobs/{job_id}/file")
async def read_file(job_id: str, key: str | None = None, authorization: str | None = Header(default=None)):
    """
    The actual bytes.

    Takes the key as a query parameter as well as a header: this URL is handed
    to the browser's own downloader (a plain navigation), which cannot carry an
    Authorization header.
    """
    if AUTH_TOKEN and not authorization:
        authorization = f"Bearer {key}" if key else None
    check_auth(authorization)

    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="No such download.")
    if job.state != "done" or not job.filename:
        raise HTTPException(status_code=409, detail="That download is not ready yet.")

    path = job.directory / job.filename
    # The name came from yt-dlp, not the client, but resolve anyway — this is
    # the one place a path leaves the process.
    if not path.resolve().is_relative_to(job.directory.resolve()) or not path.exists():
        raise HTTPException(status_code=404, detail="That file is gone.")

    return FileResponse(path, filename=job.filename, media_type="application/octet-stream")


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str, authorization: str | None = Header(default=None)) -> dict[str, bool]:
    check_auth(authorization)
    with JOBS_LOCK:
        job = JOBS.pop(job_id, None)
    if job:
        shutil.rmtree(job.directory, ignore_errors=True)
    return {"deleted": bool(job)}


# Mounted last so /api/* always wins over a same-named static file.
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
