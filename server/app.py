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
import zipfile
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Iterator, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request as UrlRequest, build_opener

import yt_dlp
from yt_dlp.downloader.external import FFmpegFD
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# --------------------------------------------------------------------- config

# Comma-separated origins, or "*". The frontend is served from GitHub Pages
# while this runs somewhere else entirely, so cross-origin is the normal case,
# not the exception. The default names that page and nothing else: the image
# serves its own interface from the same origin, which needs no entry here,
# and "*" on a server with no key would let any site the owner happens to
# visit drive it — their home IP, their YouTube session, their LAN.
HOSTED_PAGE_ORIGIN = "https://maxgfr.github.io"


def origins_from(value: str) -> list[str]:
    """
    Each entry as the origin a browser sends: scheme, host and port, no path.

    CORS compares the Origin header with each entry as written, and a page's
    address copied from the address bar (https://you.github.io/siphon/) never
    equals it: the page it named was refused.
    """
    origins = []
    for entry in (item.strip() for item in value.split(",")):
        parsed = urlparse(entry)
        if parsed.scheme and parsed.netloc:
            scheme, netloc = parsed.scheme.lower(), parsed.netloc.lower()
            default = {"http": ":80", "https": ":443"}.get(scheme, "")
            entry = f"{scheme}://{netloc.removesuffix(default)}"
        if entry:
            origins.append(entry)
    return origins


ALLOWED_ORIGINS = origins_from(os.environ.get("ALLOWED_ORIGINS", HOSTED_PAGE_ORIGIN))

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

# yt-dlp's own commentary on stderr — which client it tried, whether a
# proof-of-origin token was minted, what YouTube answered — is worth having
# when the question is "why is this failing", and noise the rest of the time.
# Off by default; the CI measurement turns it on so its log can say.
YTDLP_VERBOSE = os.environ.get("YTDLP_VERBOSE", "").strip().lower() in ("1", "true", "yes")

# A playlist is the one input that can turn a tap into hours of disk and
# bandwidth, so it is capped rather than trusted. Raise it if you know what you
# are asking for.
PLAYLIST_LIMIT = int(os.environ.get("PLAYLIST_LIMIT", "50"))

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


def write_private(path: Path, text: str) -> None:
    """Create or replace a file readable by this user only, from the first byte."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    path.chmod(0o600)


def cookie_copy(directory: Path) -> str | None:
    """
    The uploaded session, as a private copy for one yt-dlp run.

    yt-dlp writes its cookie jar back when it closes. Handed the canonical
    file, that write-back resurrected a jar the owner had just deleted — with
    the umask's permissions rather than owner-only. A copy per run means the
    uploaded file is only ever written by the upload, and deleted by delete.
    """
    if not have_cookies():
        return None
    copy = directory / ".cookies.txt"
    write_private(copy, COOKIES_PATH.read_text(encoding="utf-8"))
    return str(copy)

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
        "opts": {
            "format": "bv*+ba/b",
            "merge_output_format": "mp4",
            "postprocessors": [{"key": "FFmpegMetadata", "add_metadata": True, "add_chapters": True}],
        },
    },
    "video_1080": {
        "label": "1080p",
        "kind": "video",
        "opts": {
            "format": "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
            "merge_output_format": "mp4",
            "postprocessors": [{"key": "FFmpegMetadata", "add_metadata": True, "add_chapters": True}],
        },
    },
    "video_720": {
        "label": "720p",
        "kind": "video",
        "opts": {
            "format": "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
            "merge_output_format": "mp4",
            "postprocessors": [{"key": "FFmpegMetadata", "add_metadata": True, "add_chapters": True}],
        },
    },
    "video_480": {
        "label": "480p",
        "kind": "video",
        "opts": {
            "format": "bv*[height<=480]+ba/b[height<=480]/bv*+ba/b",
            "merge_output_format": "mp4",
            "postprocessors": [{"key": "FFmpegMetadata", "add_metadata": True, "add_chapters": True}],
        },
    },
    # Audio gets tagged, not just converted. An untagged file lands in a music
    # library as "Unknown Artist" with a blank cover, which is the difference
    # between a download you keep and one you re-do by hand. Order matters:
    # extract first, then write tags, then attach the cover to the tagged file.
    "audio_mp3": {
        "label": "MP3",
        "kind": "audio",
        "opts": {
            "format": "ba/b",
            "writethumbnail": True,
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"},
                {"key": "FFmpegMetadata", "add_metadata": True},
                {"key": "EmbedThumbnail", "already_have_thumbnail": False},
            ],
        },
    },
    "audio_m4a": {
        "label": "M4A",
        "kind": "audio",
        "opts": {
            "format": "ba[ext=m4a]/ba/b",
            "writethumbnail": True,
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "m4a", "preferredquality": "0"},
                {"key": "FFmpegMetadata", "add_metadata": True},
                {"key": "EmbedThumbnail", "already_have_thumbnail": False},
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


# The ladder and the bot-wall advice are about one site. Everywhere else they
# are noise at best: three pointless retries and, at the end, a paragraph about
# YouTube cookies for a link that was never YouTube's.
YOUTUBE_HOSTS = frozenset({
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com",
})


def is_youtube(url: str) -> bool:
    try:
        return (urlparse(url).hostname or "").lower().lstrip(".") in YOUTUBE_HOSTS
    except ValueError:
        return False


def is_bot_wall(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in BOT_WALL_MARKERS)


def player_client_chain(has_cookies: bool, first: str = "") -> list[str | None]:
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
    chain: list[str | None] = [None, "web_safari", "mweb"] if has_cookies else [None, "tv", "web_safari", "android_vr"]
    # A client the person asked for goes first; the ladder still follows it,
    # because a wall on that one is no reason to give up on the others.
    if first:
        chain = [first, *(client for client in chain if client != first)]
    return chain


# ------------------------------------------------------- per-job options

# What a page may ask yt-dlp for, per download: a short vocabulary rather than
# a passthrough, since an arbitrary option would be a way to run anything.

# YouTube clients a person may put first in the ladder: every name a page has
# offered, and of those, the ones the installed yt-dlp still has. yt-dlp drops
# the clients YouTube retires, and one it no longer knows is skipped with a
# warning nobody sees — the first rung then repeats yt-dlp's default under the
# retired client's name. tv_embedded went that way.
YT_CLIENT_NAMES = frozenset({"tv", "web_safari", "android_vr", "mweb", "web", "ios", "tv_embedded"})
try:
    from yt_dlp.extractor.youtube._base import INNERTUBE_CLIENTS as _INSTALLED_CLIENTS
except ImportError:  # moved: trust the list rather than offer nothing
    _INSTALLED_CLIENTS = YT_CLIENT_NAMES
YT_CLIENTS = frozenset(name for name in YT_CLIENT_NAMES if name in _INSTALLED_CLIENTS)

# The SponsorBlock categories worth cutting out unasked: the segments the
# community marks as skippable in every player. Chapters and highlights stay.
SPONSOR_CATEGORIES = ["sponsor", "selfpromo", "interaction"]

_TIMESTAMP = re.compile(r"^(?:(\d{1,3}):)?(?:(\d{1,2}):)?(\d{1,2}(?:\.\d{1,3})?)$")
_RATE = re.compile(r"^(\d+(?:\.\d+)?)\s*([kmg]?)(?:i?b)?(?:/s)?$", re.I)


def parse_timestamp(text: str) -> float | None:
    """'1:23' → 83.0; '01:02:03.5' → 3723.5; '' → None; anything else raises."""
    value = (text or "").strip()
    if not value:
        return None
    match = _TIMESTAMP.match(value)
    if not match:
        raise ValueError("Clip times look like 1:23 or 01:02:03.")
    hours, minutes, seconds = match.groups()
    # Two prefixes mean h:m:s; one means m:s — the regex puts a lone prefix in
    # the first group, so move it over.
    if hours is not None and minutes is None:
        hours, minutes = None, hours
    # Past the first colon the parts are clock digits: 1:99 is not a time.
    if minutes is not None and float(seconds) >= 60:
        raise ValueError("Clip times look like 1:23 or 01:02:03.")
    if hours is not None and int(minutes) >= 60:
        raise ValueError("Clip times look like 1:23 or 01:02:03.")
    return float(seconds) + 60 * int(minutes or 0) + 3600 * int(hours or 0)


def parse_rate_limit(text: str) -> int | None:
    """'500K' → 512000 bytes per second; '2M', '1.5m', '300k/s'; '' → None; junk raises."""
    value = (text or "").strip()
    if not value:
        return None
    match = _RATE.match(value)
    if not match:
        raise ValueError("A speed limit looks like 500K or 2M.")
    number, unit = match.groups()
    scale = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[unit.lower()]
    limit = int(float(number) * scale)
    if limit <= 0:
        raise ValueError("A speed limit looks like 500K or 2M.")
    return limit


def check_yt_client(text: str) -> str:
    value = (text or "").strip().lower()
    if value and value not in YT_CLIENT_NAMES:
        raise ValueError(f"Unknown YouTube client. One of: {', '.join(sorted(YT_CLIENTS))}.")
    # A retired one, from a page or a saved setting, is no preference at all:
    # refusing it would fail every download over a choice that no longer
    # exists.
    return value if value in YT_CLIENTS else ""


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


def refused_address(raw: str) -> bool:
    """
    Whether an address is somewhere this server must not reach.

    Anything that is not globally routable: private ranges, loopback,
    link-local (where the cloud metadata endpoint lives), CGNAT's 100.64/10
    (where a Tailscale network's other machines live), reserved and
    unspecified — and multicast, which is "global" by the letter only.
    """
    address = ipaddress.ip_address(raw.split("%", 1)[0])
    return not address.is_global or address.is_multicast


class PrivateAddress(socket.gaierror):
    """A name resolved, but only to somewhere this server must not reach."""


PRIVATE_ADDRESS_MESSAGE = "That address is on a private network, so it will not be fetched."

_REAL_GETADDRINFO = socket.getaddrinfo
_AI_PASSIVE = socket.AI_PASSIVE
_EAI_NONAME = socket.EAI_NONAME


_DEFAULT_PORTS = {"http": 80, "https": 443, "socks4": 1080, "socks4a": 1080, "socks5": 1080, "socks5h": 1080}


def _exempt_hosts() -> frozenset[tuple[str, int]]:
    """
    The private addresses this server is meant to reach: its proof-of-origin
    sidecar, and a proxy the operator configured. Both are named by whoever
    runs the server, never by whoever calls it.

    Each is a name *and* a port. The name alone exempted every port on that
    machine, so with the provider on 127.0.0.1:4416 a redirect to anything
    else listening on 127.0.0.1 was followed.
    """
    exempt = set()
    names = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
    for value in (POT_PROVIDER_URL, *(os.environ.get(name, "") for name in names)):
        value = value.strip()
        if not value:
            continue
        parsed = urlparse(value if "://" in value else f"http://{value}")
        try:
            port = parsed.port or _DEFAULT_PORTS.get(parsed.scheme.lower())
        except ValueError:
            continue
        if parsed.hostname and port:
            exempt.add((parsed.hostname.lower(), port))
    return frozenset(exempt)


EXEMPT_HOSTS = _exempt_hosts()


def _guarded_getaddrinfo(host: Any, port: Any, family: int = 0, type: int = 0, proto: int = 0, flags: int = 0):
    """
    socket.getaddrinfo, refusing to hand back a private address.

    assert_fetchable checks the URL a caller names, but that is only the first
    hop: yt-dlp and the tunnel follow redirects, a page can point its video at
    anything, and a name can resolve differently a second time. Checking where
    a connection is actually about to go covers all of them at once, for every
    socket this process opens — so it is installed process-wide. Lookups for
    binding a listening socket (AI_PASSIVE) are not connections and pass.
    """
    infos = _REAL_GETADDRINFO(host, port, family, type, proto, flags)
    if ALLOW_PRIVATE_HOSTS or host is None or flags & _AI_PASSIVE:
        return infos
    name = (host.decode() if isinstance(host, bytes) else str(host)).lower()
    try:
        number = int(port)
    except (TypeError, ValueError):
        number = None
    if (name, number) in EXEMPT_HOSTS:
        return infos
    for info in infos:
        if refused_address(str(info[4][0])):
            raise PrivateAddress(_EAI_NONAME, PRIVATE_ADDRESS_MESSAGE)
    return infos


socket.getaddrinfo = _guarded_getaddrinfo


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
    except PrivateAddress as exc:
        raise UnsafeUrl(PRIVATE_ADDRESS_MESSAGE) from exc
    except socket.gaierror as exc:
        raise UnsafeUrl(f"Could not resolve {parsed.hostname}.") from exc

    for info in infos:
        if refused_address(str(info[4][0])):
            raise UnsafeUrl(PRIVATE_ADDRESS_MESSAGE)
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
    # When the job reached done or error. The TTL counts from here, not from
    # `created`: a fifty-track playlist can take longer than the TTL to fetch,
    # and sweeping on age alone was deleting the directory under yt-dlp.
    finished: float | None = None
    # Set once the postprocessing step starts, so the UI can stop showing a
    # percentage that has already hit 100 and say "converting" instead.
    stage: str = "starting"
    # Which YouTube client this attempt is using, and how many walls were hit
    # before it. Both are shown, because "retrying with a different client" is
    # far less alarming than a progress bar that silently restarts.
    client: str | None = None
    attempts: int = 0
    # Playlists: which item is being fetched, out of how many. Without these the
    # bar would restart at every track and look like a fault.
    is_playlist: bool = False
    items_done: int = 0
    items_total: int = 0
    subs: str = "off"
    sub_langs: str = "en"
    # Per-job yt-dlp options, already validated: see JobRequest.
    sponsorblock: bool = False
    clip_start: float | None = None
    clip_end: float | None = None
    rate_limit: int | None = None
    yt_client: str = ""
    # Set by DELETE. The download thread checks it at every progress report
    # and stops there; without it, a cancelled job kept downloading into a
    # directory nothing would ever sweep.
    cancelled: bool = False

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
            "isPlaylist": self.is_playlist,
            "itemsDone": self.items_done,
            "itemsTotal": self.items_total,
        }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
RUNNING = threading.Semaphore(MAX_CONCURRENT_JOBS)


def sweep_expired() -> None:
    """
    Drop finished jobs and their files once they are past the TTL.

    Only finished ones: a job still running is a download in progress, and
    its directory is where yt-dlp is writing. How long it has been at it is
    no reason to pull the disk out from under it.
    """
    cutoff = time.time() - JOB_TTL_SECONDS
    with JOBS_LOCK:
        stale = [
            job
            for job in JOBS.values()
            if job.state in ("done", "error") and (job.finished or job.created) < cutoff
        ]
        for job in stale:
            JOBS.pop(job.id, None)
    for job in stale:
        shutil.rmtree(job.directory, ignore_errors=True)


JOB_DIR_NAME = re.compile(r"^[0-9a-f]{16}$")


def sweep_orphans() -> None:
    """
    Remove job directories no job owns: what a previous run of this process
    left on a volume that outlives it. Only names shaped like a job id are
    touched — the directory may be shared with other things.
    """
    with JOBS_LOCK:
        known = set(JOBS)
    for child in DOWNLOAD_ROOT.iterdir() if DOWNLOAD_ROOT.is_dir() else []:
        if child.is_dir() and JOB_DIR_NAME.match(child.name) and child.name not in known:
            shutil.rmtree(child, ignore_errors=True)


# How often the sweep runs on its own. It used to run only when a new job
# was created, so an idle server kept every finished file forever.
SWEEP_INTERVAL_SECONDS = max(30, min(300, JOB_TTL_SECONDS // 2))


# ------------------------------------------------------------------ download


# What gets zipped up at the end. Anything else in the directory is a leftover
# (a stray thumbnail, a subtitle yt-dlp could not embed) and is not the download.
# The list is long because the file keeps the site's extension whenever the
# best format is a single file — merge_output_format only applies to a merge —
# and a download in an extension missing here was fetched, tagged, and then
# reported as no file at all.
MEDIA_SUFFIXES = frozenset({
    # video
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".flv", ".f4v", ".ogv", ".ts", ".mts", ".m2ts",
    ".3gp", ".3g2", ".mpg", ".mpeg", ".wmv", ".asf", ".divx", ".mk3d",
    # audio
    ".mp3", ".m4a", ".opus", ".flac", ".wav", ".ogg", ".aac", ".mka", ".oga", ".ogx", ".weba", ".m4b",
    ".m4r", ".f4a", ".wma", ".aiff", ".alac", ".ape", ".spx",
})

# Subtitle files asked for as separate files are part of the download, not
# leftovers — without this they would be fetched and then quietly discarded.
SUBTITLE_SUFFIXES = frozenset({".srt", ".vtt", ".ass", ".ssa", ".lrc"})


def media_files(directory: Path, include_subtitles: bool = False) -> list[Path]:
    wanted = MEDIA_SUFFIXES | SUBTITLE_SUFFIXES if include_subtitles else MEDIA_SUFFIXES
    return sorted(p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in wanted)


def _hook(job: Job):
    def hook(status: dict[str, Any]) -> None:
        if job.cancelled:
            raise yt_dlp.utils.DownloadCancelled("Cancelled.")
        info = status.get("info_dict") or {}
        # yt-dlp reports these per item, so they also tell us where we are in a
        # playlist — there is no separate playlist-level progress callback.
        if info.get("playlist_index"):
            job.items_done = int(info["playlist_index"])
        if info.get("n_entries"):
            job.items_total = int(info["n_entries"])
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
        if job.cancelled:
            raise yt_dlp.utils.DownloadCancelled("Cancelled.")
        if status.get("status") == "started":
            job.stage = "processing"

    return hook


class CheckMediaUrls(yt_dlp.postprocessor.PostProcessor):
    """
    Refuse, before a byte is fetched, a chosen format that lives on a private
    address. The page's URL was checked on the way in, but the formats are
    whatever the page named. A format that is not http(s) is refused too,
    rather than waved past: rtmp, rtsp and the rest are fetched by rtmpdump,
    mplayer or ffmpeg, programs with sockets of their own that the guard
    never sees.
    """

    def run(self, info: dict[str, Any]):
        formats = info.get("requested_formats") or [info]
        for fmt in formats:
            for key in ("url", "manifest_url", "fragment_base_url"):
                value = fmt.get(key)
                if isinstance(value, str) and value:
                    try:
                        assert_fetchable(value)
                    except UnsafeUrl as exc:
                        raise yt_dlp.utils.DownloadError(str(exc)) from exc
        return [], info


# ffmpeg is the one downloader yt-dlp runs as a separate program: a playlist's
# segments and keys, and every redirect, are fetched over ffmpeg's own
# connections, which the guard above never sees — so a public playlist could
# name a private address and have its answer delivered in the file. yt-dlp
# hands ffmpeg a live stream, and any HLS its own downloader cannot read; with
# the guard on, those are refused instead, and ffmpeg only ever works on files
# already on disk.
FFMPEG_FETCH_REFUSED = (
    "This stream is live, or uses a feature only ffmpeg can fetch, and ffmpeg's connections "
    "go around this server's check for private addresses, so it is refused."
)
_REAL_FFMPEG_DOWNLOAD = FFmpegFD.real_download


def _guarded_ffmpeg_download(self: FFmpegFD, filename: str, info_dict: dict[str, Any]) -> bool:
    if not ALLOW_PRIVATE_HOSTS:
        self.report_error(FFMPEG_FETCH_REFUSED)
        return False
    return _REAL_FFMPEG_DOWNLOAD(self, filename, info_dict)


FFmpegFD.real_download = _guarded_ffmpeg_download


class CutClip(yt_dlp.postprocessor.FFmpegPostProcessor):
    """
    Cut a clip out of the downloaded file, on this machine.

    yt-dlp's own way, download_ranges, gives the remote URL to ffmpeg to
    fetch, which is exactly what the guard cannot allow. So the whole file is
    fetched the ordinary way and the span is cut here — last, so the chapters
    and any embedded subtitles are cut with it. The streams are copied, not
    re-encoded: the clip starts on the keyframe at or before the time asked
    for, so its first second is not a smear of grey, and cutting costs no
    more than a copy on a small server's CPU.
    """

    def __init__(self, start: float | None, end: float | None) -> None:
        super().__init__()
        self._start = start or 0.0
        self._end = end

    def run(self, info: dict[str, Any]):
        path = info["filepath"]
        cut = yt_dlp.utils.prepend_extension(path, "clip")
        before = ["-ss", str(self._start)] if self._start else []
        after = list(self.stream_copy_opts(ext=yt_dlp.utils.determine_ext(path)))
        if self._end is not None:
            after += ["-t", str(self._end - self._start)]
        self.real_run_ffmpeg([(path, before)], [(cut, after)])
        os.replace(cut, path)
        # Subtitles asked for as files are still beside the video, whole, and
        # would start at the video's 0:00 rather than the clip's. They are
        # SubRip by now (see build_options); embedded ones went into the file
        # before this step, and were cut with it.
        for track in (info.get("requested_subtitles") or {}).values():
            subtitle = track.get("filepath") or ""
            if subtitle.endswith(".srt") and os.path.exists(subtitle):
                clip_srt(Path(subtitle), self._start, self._end)
        return [], info


_SRT_TIME = re.compile(r"(\d+):(\d{2}):(\d{2})[,.](\d{3})")


def _srt_seconds(text: str) -> float | None:
    match = _SRT_TIME.search(text)
    if not match:
        return None
    hours, minutes, seconds, millis = (int(part) for part in match.groups())
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def _srt_time(seconds: float) -> str:
    millis = round(seconds * 1000)
    return f"{millis // 3_600_000:02d}:{millis // 60_000 % 60:02d}:{millis // 1000 % 60:02d},{millis % 1000:03d}"


def clip_srt(path: Path, start: float, end: float | None) -> None:
    """
    Keep the cues of a SubRip file that fall inside the clip, moved so the
    clip's start is 0:00. Done here because ffmpeg gets it wrong both ways:
    seeking a subtitle input shifts it by wherever the seek landed, not by
    the time asked for, and seeking the output does not shift it at all.
    """
    kept: list[str] = []
    text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").strip()
    for block in re.split(r"\n\s*\n", text):
        lines = block.split("\n")
        timing = next((index for index, line in enumerate(lines) if "-->" in line), None)
        if timing is None:
            continue
        first, _, last = lines[timing].partition("-->")
        cue_start, cue_end = _srt_seconds(first), _srt_seconds(last)
        if cue_start is None or cue_end is None or cue_end <= start or (end is not None and cue_start >= end):
            continue
        cue_start = max(cue_start, start) - start
        cue_end = (cue_end if end is None else min(cue_end, end)) - start
        kept.append("\n".join([str(len(kept) + 1), f"{_srt_time(cue_start)} --> {_srt_time(cue_end)}", *lines[timing + 1:]]))
    if kept:
        path.write_text("\n\n".join(kept) + "\n", encoding="utf-8")
    else:
        # Nothing is said during the clip: no file, rather than an empty one.
        path.unlink()


# What a track nobody asked for has to be before it is the fallback: text a
# player reads. YouTube files a live replay's chat under "subtitles",
# and Bilibili its danmaku; neither is one.
SUBTITLE_TEXT_EXTS = frozenset({"vtt", "srt", "ass", "ssa", "ttml", "dfxp"})


def pick_subtitle(written: dict[str, list], auto: dict[str, list], langs: list[str]) -> str | None:
    """
    Which one subtitle language to fetch, chosen the way the device chooses
    (pickSubtitle in web/inbrowser.js): the languages are a preference list,
    not a filter. The first one the video has wins — "en" standing for en-GB
    and en-orig too, the exact code first, a written track over a machine
    one. A video with none of them gets its first written track, or else the
    captions in its own language, rather than nothing.
    """
    for lang in (lang.lower() for lang in langs):
        for source in (written, auto):
            matches = [code for code in source if code.lower() == lang or code.lower().startswith(f"{lang}-")]
            if matches:
                return min(matches, key=lambda code: code.lower() != lang)

    def readable(code: str, source: dict[str, list]) -> bool:
        return source[code][-1].get("ext") in SUBTITLE_TEXT_EXTS

    return (
        next((code for code in written if readable(code, written)), None)
        or next((code for code in auto if code.endswith("-orig") and readable(code, auto)), None)
        or next((code for code in auto if readable(code, auto)), None)
    )


class PickSubtitle(yt_dlp.postprocessor.PostProcessor):
    """
    Replace yt-dlp's choice of subtitles with pick_subtitle's. yt-dlp reads
    each code as an exact name and fetches every one that matches, so "en"
    missed en-GB, "fr,en" on a video offering only Japanese gave nothing, and
    a machine "en" beat a human "en-US".
    """

    def __init__(self, langs: list[str]) -> None:
        super().__init__()
        self._langs = langs

    def run(self, info: dict[str, Any]):
        written = {code: formats for code, formats in (info.get("subtitles") or {}).items() if formats}
        auto = {code: formats for code, formats in (info.get("automatic_captions") or {}).items() if formats and code not in written}
        chosen = pick_subtitle(written, auto, self._langs)
        # The last format the site lists is what yt-dlp itself takes, asked
        # for no format in particular.
        info["requested_subtitles"] = {chosen: (written.get(chosen) or auto[chosen])[-1]} if chosen else None
        return [], info


def job_postprocessors(job: Job) -> list[tuple[yt_dlp.postprocessor.PostProcessor, str]]:
    """The steps yt-dlp's options cannot name, each with when it runs."""
    steps: list[tuple[yt_dlp.postprocessor.PostProcessor, str]] = [(CheckMediaUrls(), "before_dl")]
    if job.subs != "off" and PRESETS[job.preset]["kind"] == "video":
        # Before anything is fetched, after yt-dlp's own choice is made.
        steps.append((PickSubtitle([lang.strip() for lang in job.sub_langs.split(",") if lang.strip()]), "pre_process"))
    if job.clip_start is not None or job.clip_end is not None:
        steps.append((CutClip(job.clip_start, job.clip_end), "post_process"))
    return steps


def outtmpl_for(job: Job) -> str:
    """
    %(title).150B truncates on BYTES, not characters — a CJK title that fits 150
    characters can still blow past a 255-byte filesystem limit.

    Playlist items are numbered, because "track 3" is only findable if the
    filenames carry the order the playlist put them in.
    """
    if job.is_playlist:
        return "%(playlist_index)03d - %(title).120B [%(id)s].%(ext)s"
    return "%(title).150B [%(id)s].%(ext)s"


def build_options(job: Job, client: str | None) -> dict[str, Any]:
    preset = PRESETS[job.preset]
    options: dict[str, Any] = {
        # %(title).150B truncates on BYTES, not characters — a CJK title that
        # fits 150 characters can still blow past a 255-byte filesystem limit.
        "outtmpl": str(job.directory / outtmpl_for(job)),
        "noplaylist": not job.is_playlist,
        "quiet": not YTDLP_VERBOSE,
            "verbose": YTDLP_VERBOSE,
        "no_warnings": not YTDLP_VERBOSE,
        "noprogress": True,
        "restrictfilenames": False,
        "windowsfilenames": True,
        "concurrent_fragment_downloads": 4,
        # yt-dlp's own HLS downloader fetches through this process, and so
        # through the guard. An extractor that marks its stream for ffmpeg
        # would otherwise be refused outright (see _guarded_ffmpeg_download);
        # the native one hands ffmpeg only what it cannot read itself.
        "hls_prefer_native": True,
        "retries": 5,
        "fragment_retries": 5,
        "progress_hooks": [_hook(job)],
        "postprocessor_hooks": [_postprocessor_hook(job)],
        **preset["opts"],
    }
    # Subtitles are a video concern; an MP3 has nowhere to put them.
    if job.subs != "off" and preset["kind"] == "video":
        options["writesubtitles"] = True
        # Auto-captions are worth asking for: most of YouTube has nothing else,
        # and a request for human subtitles that finds none silently returns a
        # file with no subtitles at all.
        options["writeautomaticsub"] = True
        # yt-dlp's own choice, which PickSubtitle then replaces before
        # anything is fetched: see job_postprocessors.
        options["subtitleslangs"] = [lang.strip() for lang in job.sub_langs.split(",") if lang.strip()]
        if job.subs == "files":
            # SubRip, as the settings promise: YouTube's own formats are VTT
            # and its JSON variants, which fewer phone players open.
            options["postprocessors"] = [
                *options.get("postprocessors", []),
                {"key": "FFmpegSubtitlesConvertor", "format": "srt", "when": "before_dl"},
            ]
        if job.subs == "embed":
            options.setdefault("postprocessors", [])
            options["postprocessors"] = [
                *options["postprocessors"],
                {"key": "FFmpegEmbedSubtitle", "already_have_subtitle": False},
            ]

    if job.is_playlist:
        options["playlistend"] = PLAYLIST_LIMIT
        # One dead video must not abandon the other forty-nine.
        options["ignoreerrors"] = True
    cookies = cookie_copy(job.directory)
    if cookies:
        options["cookiefile"] = cookies
    if job.sponsorblock:
        # The community's segment list is fetched after the video is chosen,
        # and the cuts are made before anything else touches the file.
        options["postprocessors"] = [
            {"key": "SponsorBlock", "categories": SPONSOR_CATEGORIES, "when": "after_filter"},
            {"key": "ModifyChapters", "remove_sponsor_segments": SPONSOR_CATEGORIES, "force_keyframes": False},
            *options.get("postprocessors", []),
        ]
    # A clip is cut after the download, by CutClip: see job_postprocessors.
    if job.rate_limit:
        options["ratelimit"] = job.rate_limit
        # yt-dlp holds each fragment download to the limit on its own, so
        # four at once pulled an HLS or DASH stream at up to four times it.
        options["concurrent_fragment_downloads"] = 1
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
    try:
        _run_job(job)
    finally:
        if job.cancelled:
            shutil.rmtree(job.directory, ignore_errors=True)
        else:
            # The private cookie copy is for the run, not for the download.
            (job.directory / ".cookies.txt").unlink(missing_ok=True)


def _keep_errors(ydl: yt_dlp.YoutubeDL) -> list[str]:
    """
    Every error yt-dlp reports on this run, including the ones it then
    carries on past.

    A playlist runs with ignoreerrors, so a bot wall on every one of its
    videos raised nothing: the job came back as an empty playlist, the ladder
    never tried another client, and the advice about cookies was never given.
    """
    kept: list[str] = []
    report = ydl.report_error

    def report_error(message: str, *args: Any, **kwargs: Any) -> None:
        kept.append(str(message))
        report(message, *args, **kwargs)

    ydl.report_error = report_error
    return kept


def _swallowed(errors: list[str], otherwise: str) -> yt_dlp.utils.DownloadError:
    """
    What to fail with when nothing arrived: a bot wall if any item hit one,
    since that is the one worth another client, else the last error, else
    `otherwise`.
    """
    return yt_dlp.utils.DownloadError(next((e for e in errors if is_bot_wall(e)), errors[-1] if errors else otherwise))


def _run_job(job: Job) -> None:
    with RUNNING:
        if job.cancelled:
            return
        job.state = "running"
        attempts = player_client_chain(have_cookies(), job.yt_client) if is_youtube(job.url) else [None]
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
                    for step, when in job_postprocessors(job):
                        ydl.add_post_processor(step, when=when)
                    errors = _keep_errors(ydl)
                    info = ydl.extract_info(job.url, download=True)
                    if info is None:
                        # The playlist itself failed, and ignoreerrors said so
                        # only on stderr.
                        raise _swallowed(errors, "The download failed.")
                    if info.get("_type") == "playlist":
                        entries = [e for e in info.get("entries", []) if e]
                        if not entries:
                            raise _swallowed(errors, "That playlist is empty.")
                        if job.is_playlist:
                            # Name the job — and so the archive — after the
                            # playlist, not after whichever track happened to
                            # be first.
                            job.title = info.get("title") or entries[0].get("title")
                            job.thumbnail = entries[0].get("thumbnail")
                            info = None
                        else:
                            info = entries[0]
                    if info is not None:
                        job.title = info.get("title")
                        job.thumbnail = info.get("thumbnail")

                # Trust the directory over yt-dlp's reported path: postprocessors
                # rename the file (.webm -> .mp3) after the info dict is built, so
                # the recorded name is routinely the one that no longer exists.
                files = media_files(job.directory, include_subtitles=job.subs == "files")
                if not files:
                    raise _swallowed(errors, "yt-dlp produced no file.")

                if len(files) > 1:
                    # A browser can only be handed one file, so a playlist comes
                    # back as an archive. Stored, not deflated: every one of
                    # these is already compressed, so deflating would burn CPU
                    # over a playlist's worth of data to save nothing.
                    job.stage = "packing"
                    label = re.sub(r'[^\w\s.-]', "", job.title or "playlist").strip() or "playlist"
                    archive = job.directory / f"{label[:80]}.zip"
                    with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as bundle:
                        for item in files:
                            bundle.write(item, arcname=item.name)
                            item.unlink()
                    job.items_total = job.items_total or len(files)
                    job.items_done = job.items_total
                    chosen = archive
                else:
                    chosen = files[0]
                job.filename = chosen.name
                job.progress = 1.0
                job.stage = "ready"
                job.finished = time.time()
                job.state = "done"
                return
            except Exception as exc:  # noqa: BLE001 — surfaced to the user verbatim
                if job.cancelled:
                    return
                last_error = exc
                if index + 1 < len(attempts) and is_bot_wall(str(exc)):
                    job.attempts = index + 1
                    continue
                break

        job.stage = "failed"
        job.error = humanize_error(last_error or Exception("The download failed."), job.url)
        job.finished = time.time()
        job.state = "error"


def humanize_error(exc: Exception, url: str = "") -> str:
    """
    Turn yt-dlp's stderr-shaped messages into something worth showing a user.

    `url` decides whether the bot-wall advice applies: several of the markers
    are things yt-dlp says about any site, and telling someone to upload
    YouTube cookies for a broken MP4 link is worse than saying nothing.
    """
    text = str(exc)
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    text = re.sub(r"^ERROR:\s*", "", text).strip()
    text = re.sub(r";\s*please report this issue.*$", "", text, flags=re.S).strip()

    lowered = text.lower()
    if is_bot_wall(text) and (not url or is_youtube(url)):
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
    playlist: bool = False
    subs: str = "off"  # off | embed | files
    sub_langs: str = Field(default="en", max_length=200)
    # yt-dlp options, as the page's Advanced section offers them. Each is
    # parsed into something narrow (a float, an int, a name off a list) before
    # it reaches yt-dlp; a page cannot smuggle an option through here.
    sponsorblock: bool = False
    clip_start: str = Field(default="", max_length=20)
    clip_end: str = Field(default="", max_length=20)
    rate_limit: str = Field(default="", max_length=20)
    yt_client: str = Field(default="", max_length=32)


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
    log = logging.getLogger("uvicorn.error")
    if not AUTH_TOKEN:
        log.warning(
            "AUTH_TOKEN is not set: anyone who can reach this server can use it to download. "
            "That is fine on localhost or your own LAN. If you are putting this behind a tunnel "
            "or forwarding a port to it, set AUTH_TOKEN first."
        )
        if "*" in ALLOWED_ORIGINS:
            log.warning(
                "ALLOWED_ORIGINS is * and there is no AUTH_TOKEN: any website open in a browser "
                "that can reach this server can use it. Name your page's origin, or set a key."
            )

    # What a previous run left behind is swept now, and finished files from
    # then on — whether or not anyone starts another download.
    await asyncio.to_thread(sweep_orphans)

    async def keep_sweeping() -> None:
        while True:
            await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
            await asyncio.to_thread(sweep_expired)

    sweeper = asyncio.create_task(keep_sweeping())
    try:
        yield
    finally:
        sweeper.cancel()


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
    # The tunnel's Content-Length and Content-Range are what a progress bar and
    # a ranged download read; without this the browser is handed the bytes and
    # told nothing about them.
    expose_headers=["*"],
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


# A language code, as YouTube names its tracks: en, fr, pt-BR, zh-Hans.
SUB_LANG = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")


def check_auth(authorization: str | None) -> None:
    if not AUTH_TOKEN:
        return
    expected = f"Bearer {AUTH_TOKEN}"
    # Constant-time: a plain == leaks the token one character at a time.
    import hmac

    # Bytes, not str: compare_digest raises on a non-ASCII str, which turned a
    # wrong key into a 500.
    if not authorization or not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="This server needs an access key.")


@app.exception_handler(UnsafeUrl)
async def unsafe_url_handler(_request: Request, exc: UnsafeUrl) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# The address "Open this on your phone" names, when the server cannot see it
# for itself: in a container it sees only its own bridge network. As given,
# comma-separated.
LAN_URLS = [url.strip() for url in os.environ.get("LAN_URL", "").split(",") if url.strip()]


def in_container() -> bool:
    return os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")


def answers(address: str, port: int) -> bool:
    """
    Whether something listens on that address and port: this server, since
    it answered the request on that port. A server bound to 127.0.0.1 — what
    uvicorn does unless told otherwise — does not listen on the LAN address,
    and a phone given it is refused. A plain connect to a number, so no name
    lookup and nothing for the address guard to refuse.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        probe.connect((address, port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def lan_urls(scheme: str, port: int, proxied: bool) -> list[str]:
    """
    Where a phone on the same Wi-Fi can open this server, or nothing when
    there is no telling. In a container every address is the bridge's
    (172.17.0.x), which only the host can reach; a request that came through
    a proxy or over TLS came from somewhere a LAN address means nothing to.
    """
    if LAN_URLS:
        return LAN_URLS
    if proxied or scheme == "https" or in_container():
        return []
    return [f"http://{address}:{port}" for address in lan_addresses() if answers(address, port)]


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
        # The real lookup: these are private by definition, which is the point.
        candidates = {info[4][0] for info in _REAL_GETADDRINFO(hostname, None, socket.AF_INET)}
    except socket.gaierror:
        candidates = set()

    # getaddrinfo often reports only loopback (Debian maps the hostname to
    # 127.0.1.1), so also ask the routing table which address would be used
    # to reach the outside world.
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
    proxied = any(name in request.headers for name in ("x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded"))
    # A lookup of this machine's own name, which can hang as long as any other.
    urls = await asyncio.to_thread(lan_urls, request.url.scheme, port, proxied)
    return {
        "lanUrls": urls,
        "ok": True,
        "service": "siphon",
        "ytDlpVersion": yt_dlp.version.__version__,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        # Whether yt-dlp has a JavaScript runtime to solve YouTube's signature
        # challenge with. Without one, formats go missing; the page says so.
        "jsRuntime": shutil.which("deno") is not None,
        # What this server can do for a page. `jobs` needs ffmpeg to be worth
        # much; `resolve` and `tunnel` need only yt-dlp, and let the page do
        # the downloading and converting itself.
        "capabilities": ["jobs", "resolve", "tunnel"],
        "requiresKey": bool(AUTH_TOKEN),
        "hasCookies": have_cookies(),
        "potProvider": bool(POT_PROVIDER_URL),
        "allowsPrivateHosts": ALLOW_PRIVATE_HOSTS,
        "ytClients": sorted(YT_CLIENTS),
        "presets":[{"id": key, "label": value["label"], "kind": value["kind"]} for key, value in PRESETS.items()],
    }


@app.post("/api/probe")
async def probe(body: ProbeRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """Metadata only, no download — what the UI shows while you pick a quality."""
    check_auth(authorization)
    url = await asyncio.to_thread(assert_fetchable, body.url)

    def extract() -> dict[str, Any]:
        options = {
            "quiet": not YTDLP_VERBOSE,
            "verbose": YTDLP_VERBOSE,
            "no_warnings": not YTDLP_VERBOSE,
            "skip_download": True,
            # Look at the playlist without extracting every entry: a 200-track
            # album would otherwise mean 200 round trips before the page can
            # show a title. Single videos are unaffected — flat extraction only
            # applies to entries inside a playlist.
            "extract_flat": "in_playlist",
        }
        with tempfile.TemporaryDirectory(dir=DOWNLOAD_ROOT) as scratch:
            cookies = cookie_copy(Path(scratch))
            if cookies:
                options["cookiefile"] = cookies
            with yt_dlp.YoutubeDL(options) as ydl:
                return ydl.extract_info(url, download=False)

    try:
        info = await asyncio.wait_for(asyncio.to_thread(extract), timeout=60)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="The site took too long to answer.")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=humanize_error(exc, url))

    if info.get("_type") == "playlist":
        entries = [e for e in info.get("entries", []) if e]
        if not entries:
            raise HTTPException(status_code=400, detail="That playlist is empty.")
        first = entries[0]
        return {
            "title": info.get("title") or first.get("title"),
            "uploader": info.get("uploader") or info.get("channel") or first.get("uploader"),
            "duration": None,
            "thumbnail": info.get("thumbnails", [{}])[-1].get("url") if info.get("thumbnails") else first.get("thumbnail"),
            "extractor": info.get("extractor_key"),
            "isLive": False,
            # The UI needs all three: whether to offer the choice at all, how
            # many it would fetch, and how many it will actually get once the
            # cap applies — promising 200 and delivering 50 would be a lie.
            "isPlaylist": True,
            "count": len(entries),
            "limit": PLAYLIST_LIMIT,
            "firstTitle": first.get("title"),
        }

    return {
        "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "extractor": info.get("extractor_key"),
        "isLive": bool(info.get("is_live")),
        "isPlaylist": False,
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
    write_private(COOKIES_PATH, text + "\n")
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
    # In a thread: the check resolves the name, and a nameserver that does not
    # answer would otherwise hold every other request on the server with it.
    url = await asyncio.to_thread(assert_fetchable, body.url)
    try:
        clip_start = parse_timestamp(body.clip_start)
        clip_end = parse_timestamp(body.clip_end)
        rate_limit = parse_rate_limit(body.rate_limit)
        yt_client = check_yt_client(body.yt_client)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if clip_start is not None and clip_end is not None and clip_end <= clip_start:
        raise HTTPException(status_code=400, detail="The clip has to end after it starts.")
    if body.sponsorblock and (clip_start is not None or clip_end is not None):
        # yt-dlp measures a clip's duration as the clip's, and SponsorBlock
        # then drops every segment as belonging to a different video — so the
        # pair would quietly return the sponsors. Better to say so.
        raise HTTPException(
            status_code=400,
            detail="Sponsor removal and a clip cannot be combined. Turn one of them off.",
        )
    sub_langs = [lang.strip() for lang in body.sub_langs.split(",") if lang.strip()] or ["en"]
    if len(sub_langs) > 10 or not all(SUB_LANG.match(lang) and lang.lower() != "all" for lang in sub_langs):
        # yt-dlp reads each entry as a regular expression, and "all" as all,
        # so ".*" or "all" would fetch every auto-translated language there is.
        raise HTTPException(status_code=400, detail="Subtitle languages are codes like en, fr or pt-BR, comma-separated.")

    with JOBS_LOCK:
        active = sum(1 for job in JOBS.values() if job.state in ("queued", "running"))
        if active >= MAX_CONCURRENT_JOBS * 4:
            raise HTTPException(status_code=429, detail="Too many downloads in flight. Try again shortly.")
        job = Job(
            id=uuid.uuid4().hex[:16],
            url=url,
            preset=body.preset,
            is_playlist=body.playlist,
            subs=body.subs if body.subs in ("off", "embed", "files") else "off",
            sub_langs=",".join(sub_langs),
            sponsorblock=body.sponsorblock,
            clip_start=clip_start,
            clip_end=clip_end,
            rate_limit=rate_limit,
            yt_client=yt_client,
        )
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
        # A running download stops at its next progress report and removes
        # its own directory then; this removes what is there already.
        job.cancelled = True
        shutil.rmtree(job.directory, ignore_errors=True)
    return {"deleted": bool(job)}


# ------------------------------------------------------- resolve + tunnel

# The light half of this server: no ffmpeg, no disk, no job. `resolve` runs
# yt-dlp's extractor and hands the page the formats with their URLs — the one
# thing a page cannot do for the sites that check who is asking. `tunnel` then
# carries the bytes for the hosts that refuse a browser, and nothing else: it
# only ever fetches hosts that a resolve just named, with the headers that
# resolve said they need. The page downloads, merges and converts on its own.
#
# This is the split cobalt made, and it is the right one: the server holds the
# identity, the device does the work.

# hostname -> (headers to send, expiry). Filled by resolve, read by tunnel. A
# host stays fetchable for as long as a download could plausibly take, then
# drops out; this is what keeps the tunnel from being an open proxy.
TUNNEL_HOSTS: dict[str, tuple[dict[str, str], float]] = {}
TUNNEL_HOSTS_LOCK = threading.Lock()
TUNNEL_HOST_TTL = float(os.environ.get("TUNNEL_HOST_TTL", str(2 * 60 * 60)))
TUNNEL_CHUNK = 256 * 1024

# Request headers worth carrying to a media host, and no others: the ones a
# CDN checks. Everything else in yt-dlp's http_headers is noise for a GET of
# bytes.
TUNNEL_HEADER_NAMES = ("user-agent", "referer", "origin", "accept-language", "cookie", "authorization")


def _grant_host(url: str, headers: dict[str, Any] | None) -> None:
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return
    kept = {k: str(v) for k, v in (headers or {}).items() if k.lower() in TUNNEL_HEADER_NAMES}
    with TUNNEL_HOSTS_LOCK:
        # Several formats share a host; one of them naming headers is enough,
        # and one of them naming none must not forget them.
        previous = TUNNEL_HOSTS.get(host, ({}, 0.0))[0]
        TUNNEL_HOSTS[host] = ({**previous, **kept}, time.time() + TUNNEL_HOST_TTL)


def _granted(host: str) -> dict[str, str] | None:
    now = time.time()
    with TUNNEL_HOSTS_LOCK:
        stale = [name for name, (_, expires) in TUNNEL_HOSTS.items() if expires < now]
        for name in stale:
            TUNNEL_HOSTS.pop(name, None)
        entry = TUNNEL_HOSTS.get(host.lower())
    return entry[0] if entry else None


def format_kind(fmt: dict[str, Any]) -> str:
    """
    Whether a format carries video, audio or both.

    yt-dlp writes the string "none" when a track is definitely absent and
    leaves the field unset when it does not know — a direct .mp4 comes back
    with both unset. Reading unset as absent made every such file look like a
    codec-less nothing, which is how a plain link ended up being dropped and
    then explained with a paragraph about YouTube cookies.
    """
    video = fmt.get("vcodec") != "none"
    audio = fmt.get("acodec") != "none"
    return "muxed" if video and audio else "video" if video else "audio"


# What a page can actually use. WebVTT first: browsers read it natively and
# ffmpeg.wasm turns it into a muxed track without a second conversion.
SUBTITLE_EXTS = ("vtt", "srt", "ass")

def subtitle_tracks(info: dict[str, Any]) -> list[dict[str, Any]]:
    """
    The subtitle tracks a page could fetch for itself.

    Written ones first, then the machine ones, and never both for the same
    language: an auto-caption where a real subtitle exists is strictly worse.
    Among the machine ones, the video's own language ("en-orig") leads: the
    page falls back to the first track when none it asked for is offered.

    All of them, though YouTube's auto-translations run to a hundred and
    fifty: it lists them alphabetically by English name, so the first 25
    were Abkhazian to Corsican, with no English, French or German among them.
    """
    tracks: list[dict[str, Any]] = []
    written = set()
    for source, auto in ((info.get("subtitles") or {}, False), (info.get("automatic_captions") or {}, True)):
        for lang, options in (source or {}).items():
            if auto and lang in written:
                continue
            best = next(
                (
                    option
                    for ext in SUBTITLE_EXTS
                    for option in (options or [])
                    if option.get("ext") == ext and option.get("url")
                ),
                None,
            )
            if not best:
                continue
            if not auto:
                written.add(lang)
            tracks.append({"lang": lang, "ext": best["ext"], "url": best["url"], "auto": auto})
    # A stable sort: everything else keeps the site's order.
    return sorted(tracks, key=lambda track: track["auto"] and not track["lang"].endswith("-orig"))


def format_label(fmt: dict[str, Any]) -> str:
    """What to call a format when the site gave it no name of its own."""
    if fmt.get("height"):
        return f"{fmt['height']}p"
    kind = format_kind(fmt)
    return "audio" if kind == "audio" else "source"


def resolved_format(fmt: dict[str, Any]) -> dict[str, Any] | None:
    """
    One yt-dlp format in the shape the page's planner reads.

    Skipped: storyboards, DRM, anything without a URL, and every protocol the
    page cannot fetch itself (DASH manifests, RTMP). HLS is kept because the
    page has its own HLS downloader; a progressive URL is the common case.
    """
    url = fmt.get("url")
    protocol = str(fmt.get("protocol") or "https")
    if not url or fmt.get("has_drm") or fmt.get("ext") in ("mhtml", "storyboard"):
        return None
    if protocol.startswith("m3u8"):
        shape = "hls"
    elif protocol in ("http", "https"):
        shape = "progressive"
    else:
        return None
    # Both explicitly absent is a thumbnail or a storyboard, not media. Both
    # merely unknown is a direct file, which is the commonest link there is.
    if fmt.get("vcodec") == "none" and fmt.get("acodec") == "none":
        return None
    codecs = ",".join(c for c in (fmt.get("vcodec"), fmt.get("acodec")) if c and c != "none")
    tbr = fmt.get("tbr")
    return {
        "id": str(fmt.get("format_id") or ""),
        "url": url,
        "protocol": shape,
        "kind": format_kind(fmt),
        "container": str(fmt.get("ext") or ("mp4" if shape == "progressive" else "ts")),
        "height": fmt.get("height"),
        "width": fmt.get("width"),
        "bitrate": int(tbr * 1000) if tbr else None,
        "filesize": fmt.get("filesize") or fmt.get("filesize_approx"),
        "codecs": codecs,
        "label": fmt.get("format_note") or format_label(fmt),
    }


def resolve_url(url: str) -> dict[str, Any]:
    """
    Metadata and formats, no download, walking the client ladder on a bot
    wall exactly as a job would. Runs in a thread; yt-dlp is synchronous.
    """
    attempts = player_client_chain(have_cookies()) if is_youtube(url) else [None]
    last_error: Exception | None = None
    for index, client in enumerate(attempts):
        options: dict[str, Any] = {
            "quiet": not YTDLP_VERBOSE,
            "verbose": YTDLP_VERBOSE,
            "no_warnings": not YTDLP_VERBOSE,
            "skip_download": True,
            # A link that is a video *inside* a playlist stays one video; a link
            # that is only a playlist comes back as one, and is answered as a
            # list rather than by silently picking its first track.
            "noplaylist": True,
            # Without this a fifty-track album means fifty extractions before
            # the page can show anything.
            "extract_flat": "in_playlist",
        }
        args = extractor_args(client)
        if args:
            options["extractor_args"] = args
        try:
            with tempfile.TemporaryDirectory(dir=DOWNLOAD_ROOT) as scratch:
                cookies = cookie_copy(Path(scratch))
                if cookies:
                    options["cookiefile"] = cookies
                with yt_dlp.YoutubeDL(options) as ydl:
                    info = ydl.extract_info(url, download=False)
                    # yt-dlp keeps cookies out of a format's http_headers, so
                    # a redirect cannot carry them to another host, and sends
                    # them from its jar instead. A host that set one during
                    # extraction answers the tunnel 403 without it, so each
                    # format's is read now, while the jar is open.
                    jar = {
                        raw["url"]: ydl.cookiejar.get_cookie_header(raw["url"])
                        for raw in (*(info.get("formats") or []), info)
                        if str(raw.get("url") or "").startswith(("http://", "https://"))
                    }
            if info.get("_type") == "playlist":
                entries = [e for e in info.get("entries", []) if e]
                if not entries:
                    raise yt_dlp.utils.DownloadError("That playlist is empty.")
                # Hand back the list. The page takes it one video at a time,
                # which on a phone is better than the zip a full job builds:
                # separate files, separate progress, and each one resumable.
                kept = [
                    {"url": entry.get("url") or entry.get("webpage_url"), "title": entry.get("title")}
                    for entry in entries[:PLAYLIST_LIMIT]
                    if entry.get("url") or entry.get("webpage_url")
                ]
                return {
                    "id": str(info.get("id") or url),
                    "url": info.get("webpage_url") or url,
                    "title": info.get("title") or entries[0].get("title"),
                    "uploader": info.get("uploader") or info.get("channel"),
                    "duration": None,
                    "thumbnail": entries[0].get("thumbnail"),
                    "extractor": f"{info.get('extractor_key') or 'yt-dlp'} (server, {client or 'default'})",
                    "isLive": False,
                    "formats": [],
                    "playlist": {"count": len(entries), "limit": PLAYLIST_LIMIT, "entries": kept},
                }
            pairs = [(resolved_format(raw), raw) for raw in info.get("formats") or []]
            pairs = [(fmt, raw) for fmt, raw in pairs if fmt]
            if not pairs and info.get("url"):
                # Single-format extractors put the URL on the info itself.
                single = resolved_format({**info, "format_id": info.get("format_id") or "source"})
                if single:
                    pairs = [(single, info)]
            if not pairs:
                raise yt_dlp.utils.DownloadError("nothing downloadable was offered for that link")
            for fmt, raw in pairs:
                headers = dict(raw.get("http_headers") or {})
                if jar.get(fmt["url"]):
                    headers["Cookie"] = jar[fmt["url"]]
                _grant_host(fmt["url"], headers)
            formats = [fmt for fmt, _ in pairs]
            if info.get("thumbnail"):
                _grant_host(info["thumbnail"], None)
            subtitles = subtitle_tracks(info)
            for track in subtitles:
                _grant_host(track["url"], info.get("http_headers"))
            return {
                "id": str(info.get("id") or url),
                "url": info.get("webpage_url") or url,
                "title": info.get("title"),
                "uploader": info.get("uploader") or info.get("channel"),
                "duration": info.get("duration"),
                "thumbnail": info.get("thumbnail"),
                "extractor": f"{info.get('extractor_key') or 'yt-dlp'} (server, {client or 'default'})",
                "isLive": bool(info.get("is_live")),
                "formats": formats,
                "subtitles": subtitles,
                "playlist": None,
            }
        except Exception as exc:  # noqa: BLE001 — surfaced to the user, humanized
            last_error = exc
            if index + 1 < len(attempts) and is_bot_wall(str(exc)):
                continue
            break
    raise last_error or RuntimeError("Nothing to resolve.")


@app.post("/api/resolve")
async def resolve(body: ProbeRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """The formats behind a link, for a page that will do its own downloading."""
    check_auth(authorization)
    url = await asyncio.to_thread(assert_fetchable, body.url)
    try:
        return await asyncio.wait_for(asyncio.to_thread(resolve_url, url), timeout=90)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="The site took too long to answer.")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=humanize_error(exc, url))


class TunnelRedirects(HTTPRedirectHandler):
    """
    Follow a media host's redirect, but not with its credentials.

    CDNs redirect as a matter of course, so redirects are followed; where they
    lead is checked like the first hop (a public address — the process-wide
    guard refuses anything else at connect time). What must not follow is a
    Cookie or Authorization the resolve granted to one host: urllib copies
    every header onto the redirected request, which handed them to whichever
    host the first one pointed at. On a new host, the headers are that host's
    own grant, or none.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001 — urllib's signature
        try:
            assert_fetchable(newurl)
        except UnsafeUrl as exc:
            raise HTTPError(newurl, 403, str(exc), headers, fp) from exc
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        old_host = (urlparse(req.full_url).hostname or "").lower()
        new_host = (urlparse(newurl).hostname or "").lower()
        if new is not None and new_host != old_host:
            for name in list(new.headers):
                if name.lower() in ("cookie", "authorization"):
                    new.remove_header(name)
            for name, value in (_granted(new_host) or {}).items():
                new.add_header(name, value)
        return new


def urlopen(request: UrlRequest, timeout: float = 30) -> Any:
    """urllib's urlopen, with the tunnel's rules for redirects."""
    return build_opener(TunnelRedirects()).open(request, timeout=timeout)


def _iter_upstream(response: Any) -> Iterator[bytes]:
    try:
        while True:
            chunk = response.read(TUNNEL_CHUNK)
            if not chunk:
                break
            yield chunk
    finally:
        response.close()


@app.get("/api/tunnel")
async def tunnel(url: str, request: Request, key: str | None = None, authorization: str | None = Header(default=None)):
    """
    Carry the bytes of a URL a resolve just named, for a page the host refuses.

    Same key as everything else; same public-address guard; and one rule on top
    that neither has — the host must have come out of a recent resolve. That is
    what makes this a tunnel rather than a proxy.
    """
    if AUTH_TOKEN and not authorization:
        authorization = f"Bearer {key}" if key else None
    check_auth(authorization)
    target = await asyncio.to_thread(assert_fetchable, url)
    host = urlparse(target).hostname or ""
    extra = _granted(host)
    if extra is None:
        # X-Relay-Error marks the answer as this server's own, as the relay
        # marks its refusals: a 403 carried from the host is the host's, and
        # only this one means the tunnel would not go there.
        raise HTTPException(
            status_code=403,
            detail="Not a host this server resolved. Resolve the link first.",
            headers={"X-Relay-Error": "not a host this server resolved"},
        )

    headers = {
        # A browser's, unless the resolve said which one the host expects.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "*/*",
        **extra,
    }
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header

    def open_upstream() -> Any:
        try:
            return urlopen(UrlRequest(target, headers=headers), timeout=30)
        except HTTPError as exc:
            return exc  # an HTTPError is a response too; pass its status through
        except (URLError, OSError) as exc:
            # A host that cannot be reached at all — refused, unresolvable,
            # silent past the timeout — is not this server's fault, and not
            # a 500 with a traceback: it is the upstream, and the page reads
            # a 502 as "try again", which is the right reading.
            reason = getattr(exc, "reason", None) or exc
            raise HTTPException(
                status_code=502, detail=f"Could not reach {host}: {reason}", headers={"X-Relay-Error": "upstream unreachable"}
            ) from exc

    upstream = await asyncio.to_thread(open_upstream)
    status = getattr(upstream, "status", None) or getattr(upstream, "code", 502)
    passed = {}
    for name in ("content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"):
        value = upstream.headers.get(name) if hasattr(upstream, "headers") else None
        if value:
            passed[name] = value
    if status >= 400:
        detail = f"{host} answered {status}."
        upstream.close()
        raise HTTPException(status_code=status if status in (403, 404, 410, 416, 429) else 502, detail=detail)
    return StreamingResponse(_iter_upstream(upstream), status_code=status, headers=passed)


# Mounted last so /api/* always wins over a same-named static file.
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
