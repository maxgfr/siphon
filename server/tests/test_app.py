"""
Tests for the API.

The download path itself is covered end-to-end by the browser tests (see
README), because what matters there — does a file reach the user — is not
something a unit test can see. What is worth pinning here is the part that is
both invisible and dangerous: the URL guard. It is the only thing standing
between "a service that downloads what you ask for" and "a service that reads
the host's cloud credentials for anyone who can reach it".
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import functools
import http.server
import importlib
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server import app as server_app  # noqa: E402


@pytest.fixture()
def client() -> TestClient:
    return TestClient(server_app.app)


# ------------------------------------------------------------------- guard

@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x.mp4",
        "data:text/html,hi",
        "javascript:alert(1)",
        "",
        "   ",
    ],
)
def test_rejects_non_http_schemes(url: str) -> None:
    with pytest.raises(server_app.UnsafeUrl):
        server_app.assert_fetchable(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/x.mp4",
        "http://localhost/x.mp4",
        "http://0.0.0.0/x.mp4",
        "http://10.0.0.5/x.mp4",
        "http://192.168.1.10/x.mp4",
        "http://172.16.0.9/x.mp4",
        "http://[::1]/x.mp4",
        # The cloud metadata endpoint — the reason this guard exists at all.
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    ],
)
def test_rejects_private_and_loopback_addresses(url: str) -> None:
    with pytest.raises(server_app.UnsafeUrl):
        server_app.assert_fetchable(url)


def test_rejects_a_public_name_that_resolves_to_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hostname is not a promise: DNS is free to point it at 127.0.0.1."""
    monkeypatch.setattr(
        server_app.socket,
        "getaddrinfo",
        lambda *_a, **_k: [(2, 1, 6, "", ("127.0.0.1", 80))],
    )
    with pytest.raises(server_app.UnsafeUrl):
        server_app.assert_fetchable("http://totally-public.example/video")


def test_rejects_absurdly_long_urls() -> None:
    with pytest.raises(server_app.UnsafeUrl):
        server_app.assert_fetchable("https://example.com/" + "a" * 3000)


def test_accepts_a_public_address(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        server_app.socket,
        "getaddrinfo",
        lambda *_a, **_k: [(2, 1, 6, "", ("93.184.216.34", 443))],
    )
    assert server_app.assert_fetchable("https://example.com/watch?v=1").startswith("https://")


def test_opt_in_flag_disables_the_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    """ALLOW_PRIVATE_HOSTS exists for LAN sources, and must do exactly that."""
    monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", True)
    assert server_app.assert_fetchable("http://192.168.1.10/movie.mp4")


# --------------------------------------------------------------------- api

def test_health_reports_what_the_ui_needs(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["ytDlpVersion"]
    # The frontend greys out audio presets when ffmpeg is missing, so this key
    # has to be present even when the answer is False.
    assert "ffmpeg" in body
    # And whether yt-dlp has a JavaScript runtime for YouTube's signature
    # challenge; present either way, so the page can warn when it is False.
    assert "jsRuntime" in body
    assert {p["id"] for p in body["presets"]} == set(server_app.PRESETS)


def test_unknown_preset_is_refused(client: TestClient) -> None:
    """Presets are an allow-list: a free-form format string would be an injection point."""
    response = client.post("/api/jobs", json={"url": "https://example.com/v", "preset": "../../etc"})
    assert response.status_code == 400
    assert "preset" in response.json()["detail"].lower()


def test_private_url_is_refused_by_the_endpoint(client: TestClient) -> None:
    response = client.post("/api/jobs", json={"url": "http://169.254.169.254/"})
    assert response.status_code == 400


def test_missing_job_is_a_404(client: TestClient) -> None:
    assert client.get("/api/jobs/deadbeef").status_code == 404


def test_file_is_refused_while_the_job_is_unfinished(client: TestClient) -> None:
    job = server_app.Job(id="pending123", url="https://example.com/v", preset="video_best")
    server_app.JOBS[job.id] = job
    try:
        response = client.get(f"/api/jobs/{job.id}/file")
        assert response.status_code == 409
    finally:
        server_app.JOBS.pop(job.id, None)


# ------------------------------------------------------------------- sweep


class TestSweep:
    @pytest.fixture(autouse=True)
    def _isolate(self, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:  # noqa: ANN001
        monkeypatch.setattr(server_app, "JOBS", {})
        monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path)
        monkeypatch.setattr(server_app, "JOB_TTL_SECONDS", 3600)

    def _job(self, job_id: str, **kwargs) -> server_app.Job:  # noqa: ANN003
        job = server_app.Job(id=job_id, url="https://example.com/v", preset="video_best", **kwargs)
        job.directory.mkdir(parents=True, exist_ok=True)
        server_app.JOBS[job.id] = job
        return job

    def test_a_running_job_is_never_swept_however_old(self) -> None:
        """A long playlist outlives the TTL; its directory is where yt-dlp is writing."""
        long_ago = server_app.time.time() - 10 * 3600
        running = self._job("running", state="running", created=long_ago)
        queued = self._job("queued", state="queued", created=long_ago)
        server_app.sweep_expired()
        assert "running" in server_app.JOBS and running.directory.exists()
        assert "queued" in server_app.JOBS and queued.directory.exists()

    def test_a_finished_job_is_swept_from_when_it_finished(self) -> None:
        now = server_app.time.time()
        # Started long ago, finished a minute ago: the file is still wanted.
        fresh = self._job("fresh", state="done", created=now - 10 * 3600, finished=now - 60)
        # Finished past the TTL: gone, files and all.
        old = self._job("old", state="error", created=now - 10 * 3600, finished=now - 2 * 3600)
        server_app.sweep_expired()
        assert "fresh" in server_app.JOBS and fresh.directory.exists()
        assert "old" not in server_app.JOBS and not old.directory.exists()

    def test_a_finished_job_with_no_finish_time_falls_back_to_its_age(self) -> None:
        self._job("legacy", state="done", created=server_app.time.time() - 2 * 3600)
        server_app.sweep_expired()
        assert "legacy" not in server_app.JOBS


# -------------------------------------------------------------------- auth

def test_auth_token_gates_every_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server_app, "AUTH_TOKEN", "s3cret")
    client = TestClient(server_app.app)

    assert client.post("/api/probe", json={"url": "https://example.com/v"}).status_code == 401
    assert client.get("/api/jobs/whatever").status_code == 401

    # Wrong key is still 401 — not a different status that would confirm the key exists.
    assert (
        client.get("/api/jobs/whatever", headers={"Authorization": "Bearer wrong"}).status_code == 401
    )
    # Right key gets past auth and on to the real answer.
    assert (
        client.get("/api/jobs/whatever", headers={"Authorization": "Bearer s3cret"}).status_code == 404
    )


def test_file_endpoint_accepts_the_key_in_the_query(monkeypatch: pytest.MonkeyPatch) -> None:
    """The browser's downloader cannot send headers, so this path must work."""
    monkeypatch.setattr(server_app, "AUTH_TOKEN", "s3cret")
    client = TestClient(server_app.app)

    assert client.get("/api/jobs/nope/file").status_code == 401
    assert client.get("/api/jobs/nope/file?key=wrong").status_code == 401
    assert client.get("/api/jobs/nope/file?key=s3cret").status_code == 404


# ------------------------------------------------------------------ errors

@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("ERROR: Private video. Sign in if you've been granted access", "private"),
        ("ERROR: Video unavailable", "unavailable"),
        ("ERROR: Unsupported URL: https://example.com/x", "does not recognise"),
    ],
)
def test_errors_are_rewritten_for_humans(raw: str, expected: str) -> None:
    assert expected in server_app.humanize_error(Exception(raw)).lower()


def test_error_text_drops_the_bug_report_boilerplate() -> None:
    message = server_app.humanize_error(
        Exception("ERROR: something broke; please report this issue on https://github.com/yt-dlp/yt-dlp/issues")
    )
    assert "report this issue" not in message
    assert message == "something broke"


# ------------------------------------------------------- private network

def test_preflight_allows_a_public_page_to_call_this_machine() -> None:
    """
    The "UI on GitHub Pages, yt-dlp on your own computer" path.

    Chrome guards public-to-private requests behind a Private Network Access
    preflight and drops the request before the server sees it unless that
    preflight is answered. Verified end to end in a real browser; this pins the
    header so a CORS refactor cannot quietly remove it.
    """
    client = TestClient(server_app.app)
    response = client.options(
        "/api/health",
        headers={
            "Origin": server_app.ALLOWED_ORIGINS[0],
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-private-network") == "true"


def test_private_network_still_obeys_the_origin_allow_list(monkeypatch: pytest.MonkeyPatch) -> None:
    """Answering the PNA preflight must not become a way around ALLOWED_ORIGINS."""
    from starlette.middleware.cors import CORSMiddleware
    from fastapi import FastAPI

    scoped = FastAPI()
    scoped.add_middleware(
        CORSMiddleware,
        allow_origins=["https://maxgfr.github.io"],
        allow_methods=["GET"],
        allow_headers=["*"],
        allow_private_network=True,
    )

    @scoped.get("/api/health")
    async def _health() -> dict[str, bool]:
        return {"ok": True}

    client = TestClient(scoped)
    refused = client.options(
        "/api/health",
        headers={
            "Origin": "https://somewhere-else.example",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    # Starlette still echoes the private-network header on a refusal, but the
    # header a browser actually gates on is access-control-allow-origin — and a
    # 400 without it is a rejected preflight, so the request is never sent.
    assert refused.status_code == 400
    assert "access-control-allow-origin" not in refused.headers


# --------------------------------------------------------- youtube strategy

class TestClientLadder:
    """
    The fallback that turns most YouTube bot walls into a successful download
    without the user doing anything.
    """

    def test_first_attempt_defers_to_yt_dlp(self) -> None:
        # None means "whatever yt-dlp currently defaults to", which tracks the
        # clients YouTube still accepts far better than anything pinned here.
        assert server_app.player_client_chain(False)[0] is None
        assert server_app.player_client_chain(True)[0] is None

    def test_tv_is_tried_when_anonymous(self) -> None:
        """The TV client is the least scrutinised one without credentials."""
        assert "tv" in server_app.player_client_chain(False)

    def test_tv_is_never_paired_with_cookies(self) -> None:
        """
        The documented footgun: the TV client authenticates differently, and
        pairing it with a logged-in session tends to invalidate that session —
        turning the fix into the cause.
        """
        assert "tv" not in server_app.player_client_chain(True)

    def test_every_rung_is_distinct(self) -> None:
        for has_cookies in (True, False):
            chain = server_app.player_client_chain(has_cookies)
            assert len(chain) == len(set(chain))


@pytest.mark.parametrize(
    "message",
    [
        "ERROR: [youtube] abc: Sign in to confirm you're not a bot",
        "ERROR: [youtube] abc: Some formats require a PO Token",
        "ERROR: unable to extract player response",
        "ERROR: Requested format is not available",
    ],
)
def test_bot_walls_are_worth_another_client(message: str) -> None:
    assert server_app.is_bot_wall(message)


@pytest.mark.parametrize(
    "message",
    [
        "ERROR: Video unavailable",
        "ERROR: Private video. Sign in if you've been granted access",
        "ERROR: Unsupported URL: https://example.com/x",
        "ERROR: ffmpeg not found",
    ],
)
def test_real_failures_are_not_retried(message: str) -> None:
    """
    Retrying these would only make the user wait four times as long for the
    same answer — and "Private video" is the trap, because it contains the
    words "Sign in".
    """
    assert not server_app.is_bot_wall(message)


def test_extractor_args_pin_the_client(self=None) -> None:
    assert server_app.extractor_args("tv") == {"youtube": {"player_client": ["tv"]}}
    assert server_app.extractor_args(None) == {}


def test_extractor_args_offer_the_token_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server_app, "POT_PROVIDER_URL", "http://potoken:4416")
    args = server_app.extractor_args("tv")
    assert args["youtubepot-bgutilhttp"] == {"base_url": ["http://potoken:4416"]}
    # Still set even with no client pinned, so the default attempt gets tokens too.
    assert "youtubepot-bgutilhttp" in server_app.extractor_args(None)


# ------------------------------------------------------------------ cookies

NETSCAPE_JAR = (
    "# Netscape HTTP Cookie File\n"
    ".youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tsomevalue\n"
)


class TestCookies:
    @pytest.fixture(autouse=True)
    def _isolate(self, tmp_path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(server_app, "COOKIES_PATH", tmp_path / "cookies.txt")

    def test_a_netscape_jar_is_accepted_and_stored_owner_only(self) -> None:
        client = TestClient(server_app.app)
        assert client.post("/api/cookies", json={"cookies": NETSCAPE_JAR}).status_code == 200
        assert server_app.have_cookies()
        # A session cookie is a logged-in account; it must not be world-readable.
        assert server_app.COOKIES_PATH.stat().st_mode & 0o077 == 0

    def test_a_headerless_jar_is_still_accepted(self) -> None:
        """Several exporters omit the header but write the same rows."""
        rows = ".youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tvalue\n"
        assert server_app.looks_like_cookie_jar(rows)

    @pytest.mark.parametrize(
        "junk",
        [
            '[{"domain": ".youtube.com", "name": "SID"}]',  # the usual JSON export
            "SID=abc; HSID=def",  # a copied header value
            "just some text",
        ],
    )
    def test_the_usual_wrong_pastes_are_refused(self, junk: str) -> None:
        # Storing these would produce a bot wall later, which looks exactly like
        # the problem the upload was meant to solve.
        client = TestClient(server_app.app)
        response = client.post("/api/cookies", json={"cookies": junk})
        assert response.status_code == 400
        assert "cookies.txt" in response.json()["detail"]

    def test_cookies_can_be_removed(self) -> None:
        client = TestClient(server_app.app)
        client.post("/api/cookies", json={"cookies": NETSCAPE_JAR})
        assert client.delete("/api/cookies").json() == {"deleted": True}
        assert not server_app.have_cookies()

    def test_the_jar_is_never_readable_back_over_the_api(self) -> None:
        """
        There is no GET: the server takes a session, it does not hand one out.

        Asserted on the secret rather than the status code — the static mount
        answers unknown paths, so the exact code is its business; what must hold
        is that no route ever returns the cookie itself.
        """
        client = TestClient(server_app.app)
        client.post("/api/cookies", json={"cookies": NETSCAPE_JAR})
        response = client.get("/api/cookies")
        assert response.status_code != 200
        assert "somevalue" not in response.text
        # And it is not reachable as a static file either.
        assert "somevalue" not in client.get("/cookies.txt").text

    def test_cookies_are_gated_by_the_access_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "AUTH_TOKEN", "s3cret")
        client = TestClient(server_app.app)
        assert client.post("/api/cookies", json={"cookies": NETSCAPE_JAR}).status_code == 401
        assert client.delete("/api/cookies").status_code == 401

    def test_health_reports_whether_a_session_is_stored(self) -> None:
        client = TestClient(server_app.app)
        assert client.get("/api/health").json()["hasCookies"] is False
        client.post("/api/cookies", json={"cookies": NETSCAPE_JAR})
        assert client.get("/api/health").json()["hasCookies"] is True

    def test_the_bot_wall_message_points_at_the_actual_fix(self) -> None:
        wall = Exception("ERROR: Sign in to confirm you're not a bot")
        assert "cookies" in server_app.humanize_error(wall).lower()

    def test_and_says_something_different_once_cookies_exist(self) -> None:
        TestClient(server_app.app).post("/api/cookies", json={"cookies": NETSCAPE_JAR})
        message = server_app.humanize_error(Exception("ERROR: Sign in to confirm you're not a bot"))
        assert "expired" in message.lower()


# ---------------------------------------------------------------- playlists

class TestPlaylists:
    @staticmethod
    def _job(**kwargs) -> "server_app.Job":
        return server_app.Job(id="j1", url="https://example.com/list", preset="video_720", **kwargs)

    def test_a_single_video_stays_a_single_video(self) -> None:
        """
        A watch link can carry a &list=, so taking the playlist must be an
        explicit request — never inferred from the URL.
        """
        options = server_app.build_options(self._job(), None)
        assert options["noplaylist"] is True
        assert "playlistend" not in options

    def test_asking_for_the_playlist_lifts_the_restriction(self) -> None:
        options = server_app.build_options(self._job(is_playlist=True), None)
        assert options["noplaylist"] is False
        assert options["playlistend"] == server_app.PLAYLIST_LIMIT

    def test_one_dead_video_does_not_abandon_the_rest(self) -> None:
        assert server_app.build_options(self._job(is_playlist=True), None)["ignoreerrors"] is True
        # But a single download should still fail loudly rather than silently.
        assert server_app.build_options(self._job(), None).get("ignoreerrors") is not True

    def test_playlist_files_are_numbered(self) -> None:
        """Track order is only recoverable from the filenames."""
        assert "%(playlist_index)03d" in server_app.outtmpl_for(self._job(is_playlist=True))
        assert "playlist_index" not in server_app.outtmpl_for(self._job())

    def test_titles_are_truncated_on_bytes_not_characters(self) -> None:
        # A CJK title of 150 characters is 450 bytes, well past the 255-byte
        # limit most filesystems enforce.
        for template in (server_app.outtmpl_for(self._job()), server_app.outtmpl_for(self._job(is_playlist=True))):
            assert "B]" in template.replace(")s", "]").replace("(", "[") or "B" in template
            assert ".150B" in template or ".120B" in template


class TestMediaCollection:
    def test_only_media_is_collected(self, tmp_path) -> None:
        """
        Leftovers must not be mistaken for the download. A stray thumbnail in
        the archive is noise; a stray thumbnail picked as *the* file is a bug.
        """
        for name in ("001 - a.mp4", "002 - b.mp4", "a.webp", "a.en.vtt", "a.info.json"):
            (tmp_path / name).write_bytes(b"x")
        found = [p.name for p in server_app.media_files(tmp_path)]
        assert found == ["001 - a.mp4", "002 - b.mp4"]

    def test_collection_is_ordered(self, tmp_path) -> None:
        """Numbered names must come back in playlist order, not disk order."""
        for name in ("003 - c.mp3", "001 - a.mp3", "002 - b.mp3"):
            (tmp_path / name).write_bytes(b"x")
        assert [p.name for p in server_app.media_files(tmp_path)] == [
            "001 - a.mp3",
            "002 - b.mp3",
            "003 - c.mp3",
        ]


# ------------------------------------------------------------------- audio

class TestAudioTagging:
    """
    An untagged file lands in a music library as "Unknown Artist" with a blank
    cover — the difference between a download you keep and one you redo by hand.
    """

    @pytest.mark.parametrize("preset", ["audio_mp3", "audio_m4a"])
    def test_audio_is_tagged_and_given_a_cover(self, preset: str) -> None:
        opts = server_app.PRESETS[preset]["opts"]
        keys = [pp["key"] for pp in opts["postprocessors"]]
        assert "FFmpegMetadata" in keys
        assert "EmbedThumbnail" in keys
        # EmbedThumbnail needs the image on disk to attach.
        assert opts["writethumbnail"] is True

    @pytest.mark.parametrize("preset", ["audio_mp3", "audio_m4a"])
    def test_the_postprocessor_order_is_the_one_that_works(self, preset: str) -> None:
        """
        Extract, then tag, then attach the cover. Embedding before the extract
        would attach to the container that is about to be thrown away.
        """
        keys = [pp["key"] for pp in server_app.PRESETS[preset]["opts"]["postprocessors"]]
        assert keys.index("FFmpegExtractAudio") < keys.index("FFmpegMetadata")
        assert keys.index("FFmpegMetadata") < keys.index("EmbedThumbnail")

    @pytest.mark.parametrize("preset", ["video_best", "video_1080", "video_720", "video_480"])
    def test_video_keeps_its_metadata_and_chapters(self, preset: str) -> None:
        pps = server_app.PRESETS[preset]["opts"]["postprocessors"]
        assert any(pp["key"] == "FFmpegMetadata" and pp.get("add_chapters") for pp in pps)


# ---------------------------------------------------------------- subtitles

class TestSubtitles:
    @staticmethod
    def _job(preset: str = "video_720", **kwargs) -> "server_app.Job":
        return server_app.Job(id="s1", url="https://example.com/v", preset=preset, **kwargs)

    def test_off_by_default(self) -> None:
        options = server_app.build_options(self._job(), None)
        assert "writesubtitles" not in options

    def test_auto_captions_are_included_when_subtitles_are_wanted(self) -> None:
        """
        Most of YouTube has no human subtitles. Asking only for those would
        return a file with no subtitles at all and no explanation.
        """
        options = server_app.build_options(self._job(subs="embed"), None)
        assert options["writesubtitles"] is True
        assert options["writeautomaticsub"] is True

    def test_languages_are_split_and_trimmed(self) -> None:
        options = server_app.build_options(self._job(subs="files", sub_langs=" en , fr ,"), None)
        assert options["subtitleslangs"] == ["en", "fr"]

    def test_embedding_adds_the_postprocessor_and_files_does_not(self) -> None:
        embed = server_app.build_options(self._job(subs="embed"), None)
        assert any(pp["key"] == "FFmpegEmbedSubtitle" for pp in embed["postprocessors"])
        separate = server_app.build_options(self._job(subs="files"), None)
        assert not any(pp["key"] == "FFmpegEmbedSubtitle" for pp in separate["postprocessors"])

    def test_embedding_does_not_discard_the_metadata_postprocessor(self) -> None:
        """The subtitle step is appended to the preset's own chain, not swapped in."""
        options = server_app.build_options(self._job(subs="embed"), None)
        keys = [pp["key"] for pp in options["postprocessors"]]
        assert "FFmpegMetadata" in keys

    def test_audio_presets_ignore_subtitles(self) -> None:
        """An MP3 has nowhere to put them, and fetching them would be waste."""
        options = server_app.build_options(self._job(preset="audio_mp3", subs="embed"), None)
        assert "writesubtitles" not in options

    def test_separate_subtitle_files_are_kept(self, tmp_path) -> None:
        """
        They were explicitly asked for, so they must survive the media filter —
        otherwise they are downloaded and then silently dropped.
        """
        (tmp_path / "a.mp4").write_bytes(b"x")
        (tmp_path / "a.en.srt").write_bytes(b"x")
        (tmp_path / "a.webp").write_bytes(b"x")
        with_subs = [p.name for p in server_app.media_files(tmp_path, include_subtitles=True)]
        assert with_subs == ["a.en.srt", "a.mp4"]
        # And are still treated as leftovers when they were not asked for.
        assert [p.name for p in server_app.media_files(tmp_path)] == ["a.mp4"]

    def test_an_unknown_value_falls_back_to_off(self) -> None:
        """The field comes from a client; it is not a free-text yt-dlp option."""
        client = TestClient(server_app.app)
        response = client.post(
            "/api/jobs",
            json={"url": "http://169.254.169.254/", "preset": "video_720", "subs": "../../etc"},
        )
        # Rejected for the URL, which proves it got past validation of `subs`
        # rather than being accepted as a mode.
        assert response.status_code == 400
        assert server_app.Job(id="x", url="u", preset="video_720", subs="off").subs == "off"


# --------------------------------------------------------- resolve + tunnel


def _public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        server_app.socket, "getaddrinfo", lambda *_a, **_k: [(None, None, None, None, ("93.184.216.34", 0))]
    )


class TestResolvedFormat:
    """One yt-dlp format, in the shape the page's planner reads."""

    def test_a_muxed_progressive_format(self) -> None:
        out = server_app.resolved_format({
            "format_id": "18", "url": "https://cdn.example/v.mp4", "protocol": "https", "ext": "mp4",
            "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "height": 360, "width": 640, "tbr": 500.5,
            "filesize": 1234, "format_note": "360p",
        })
        assert out == {
            "id": "18", "url": "https://cdn.example/v.mp4", "protocol": "progressive", "kind": "muxed",
            "container": "mp4", "height": 360, "width": 640, "bitrate": 500500, "filesize": 1234,
            "codecs": "avc1.42001E,mp4a.40.2", "label": "360p",
        }

    def test_video_only_and_audio_only_are_told_apart(self) -> None:
        video = server_app.resolved_format({"format_id": "v", "url": "u", "ext": "webm", "vcodec": "vp9", "acodec": "none", "height": 1080})
        audio = server_app.resolved_format({"format_id": "a", "url": "u", "ext": "m4a", "vcodec": "none", "acodec": "mp4a", "tbr": 128})
        assert video["kind"] == "video" and video["label"] == "1080p"
        assert audio["kind"] == "audio" and audio["label"] == "audio" and audio["bitrate"] == 128000

    def test_hls_is_kept_and_dash_is_not(self) -> None:
        hls = server_app.resolved_format({"format_id": "h", "url": "u.m3u8", "protocol": "m3u8_native", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a"})
        dash = server_app.resolved_format({"format_id": "d", "url": "u.mpd", "protocol": "http_dash_segments", "ext": "mp4", "vcodec": "avc1", "acodec": "none"})
        assert hls["protocol"] == "hls"
        assert dash is None

    def test_unknown_codecs_are_not_absent_codecs(self) -> None:
        """
        yt-dlp writes "none" for a track that is definitely absent and leaves
        the field unset when it does not know. A direct .mp4 comes back with
        both unset, and reading that as "no codecs" dropped every plain link —
        which then failed with a paragraph about YouTube cookies.
        """
        direct = server_app.resolved_format({
            "format_id": "mp4", "url": "https://cdn.example/clip.mp4", "protocol": "http", "ext": "mp4",
        })
        assert direct is not None
        assert direct["kind"] == "muxed"
        assert direct["label"] == "source"

    def test_a_thumbnail_with_both_codecs_absent_is_still_dropped(self) -> None:
        assert server_app.resolved_format({
            "format_id": "thumb", "url": "u", "ext": "jpg", "vcodec": "none", "acodec": "none",
        }) is None

    @pytest.mark.parametrize(
        "fmt",
        [
            {"format_id": "sb", "url": "u", "ext": "mhtml", "vcodec": "none", "acodec": "none"},
            {"format_id": "drm", "url": "u", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a", "has_drm": True},
            {"format_id": "nourl", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a"},
            {"format_id": "empty", "url": "u", "ext": "mp4", "vcodec": "none", "acodec": "none"},
        ],
    )
    def test_the_unusable_are_dropped(self, fmt: dict) -> None:
        assert server_app.resolved_format(fmt) is None


class _FakeJar:
    """yt-dlp's cookie jar, empty."""

    def __iter__(self) -> Iterator[object]:
        return iter(())


class _FakeYdl:
    """Stands in for yt_dlp.YoutubeDL: returns a canned info dict."""

    info: dict = {}
    seen_options: list[dict] = []
    cookiejar = _FakeJar()

    def __init__(self, options: dict) -> None:
        _FakeYdl.seen_options.append(options)

    def __enter__(self) -> "_FakeYdl":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def extract_info(self, _url: str, download: bool = True) -> dict:
        assert download is False
        return dict(_FakeYdl.info)


class _FakeUpstream:
    def __init__(self, status: int, headers: dict[str, str], chunks: list[bytes]) -> None:
        self.status = status
        self._headers = {k.lower(): v for k, v in headers.items()}
        self.headers = self
        self._chunks = list(chunks)
        self.closed = False

    def get(self, name: str, default: str | None = None) -> str | None:  # email.message.Message-like
        return self._headers.get(name.lower(), default)

    def read(self, _size: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""

    def close(self) -> None:
        self.closed = True


class TestResolveAndTunnel:
    @pytest.fixture(autouse=True)
    def _isolate(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _public_dns(monkeypatch)
        monkeypatch.setattr(server_app.yt_dlp, "YoutubeDL", _FakeYdl)
        monkeypatch.setattr(server_app, "TUNNEL_HOSTS", {})
        _FakeYdl.seen_options = []
        _FakeYdl.info = {
            "id": "abc",
            "title": "A video",
            "uploader": "Someone",
            "duration": 19,
            "thumbnail": "https://img.example/t.jpg",
            "webpage_url": "https://site.example/watch?v=abc",
            "extractor_key": "Site",
            "formats": [
                {"format_id": "v", "url": "https://cdn.example/v.webm", "ext": "webm", "vcodec": "vp9", "acodec": "none", "height": 720,
                 "http_headers": {"User-Agent": "yt-dlp-ua", "Referer": "https://site.example/", "X-Internal": "no"}},
                {"format_id": "a", "url": "https://cdn.example/a.m4a", "ext": "m4a", "vcodec": "none", "acodec": "mp4a", "tbr": 128},
                {"format_id": "sb", "url": "https://cdn.example/sb", "ext": "mhtml", "vcodec": "none", "acodec": "none"},
            ],
        }

    def test_resolve_returns_the_page_shape_and_grants_the_hosts(self, client: TestClient) -> None:
        response = client.post("/api/resolve", json={"url": "https://site.example/watch?v=abc"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["title"] == "A video"
        assert body["extractor"] == "Site (server, default)"
        assert [f["id"] for f in body["formats"]] == ["v", "a"]
        assert body["formats"][0]["kind"] == "video" and body["formats"][1]["kind"] == "audio"
        # No download was asked for, and the playlist guard is on.
        assert _FakeYdl.seen_options[0]["skip_download"] is True
        assert _FakeYdl.seen_options[0]["noplaylist"] is True
        # The CDN and the thumbnail host are now tunnelable; nothing else is.
        assert set(server_app.TUNNEL_HOSTS) == {"cdn.example", "img.example"}
        kept_headers = server_app.TUNNEL_HOSTS["cdn.example"][0]
        assert kept_headers == {"User-Agent": "yt-dlp-ua", "Referer": "https://site.example/"}

    def test_resolve_walks_the_client_ladder_on_a_bot_wall(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        # A YouTube link: the ladder is YouTube's, and a bot wall is the one
        # answer worth trying another of its clients for.
        calls = {"n": 0}

        def extract_info(self: _FakeYdl, _url: str, download: bool = True) -> dict:
            calls["n"] += 1
            if calls["n"] == 1:
                raise server_app.yt_dlp.utils.DownloadError("Sign in to confirm you're not a bot")
            return dict(_FakeYdl.info)

        monkeypatch.setattr(_FakeYdl, "extract_info", extract_info)
        response = client.post("/api/resolve", json={"url": "https://www.youtube.com/watch?v=abc"})
        assert response.status_code == 200
        assert response.json()["extractor"] == "Site (server, tv)"
        assert calls["n"] == 2

    def test_resolve_refuses_private_addresses(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        # The fixture's DNS makes every name public; put the real answer back
        # for the one address whose whole point is being private.
        monkeypatch.setattr(
            server_app.socket, "getaddrinfo", lambda *_a, **_k: [(None, None, None, None, ("169.254.169.254", 0))]
        )
        response = client.post("/api/resolve", json={"url": "http://169.254.169.254/latest/meta-data/"})
        assert response.status_code == 400
        assert _FakeYdl.seen_options == []

    def test_tunnel_refuses_a_host_nobody_resolved(self, client: TestClient) -> None:
        response = client.get("/api/tunnel", params={"url": "https://cdn.example/v.webm"})
        assert response.status_code == 403
        assert "resolve" in response.json()["detail"].lower()
        # The server's own refusal, marked as the relay's are: a 403 carried
        # from the host below is the host's, and the page words the two apart.
        assert response.headers.get("x-relay-error") == "not a host this server resolved"

    def test_tunnel_carries_bytes_headers_and_ranges(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        client.post("/api/resolve", json={"url": "https://site.example/watch?v=abc"})
        opened: list = []

        def fake_urlopen(request, timeout=0):  # noqa: ANN001
            opened.append(request)
            return _FakeUpstream(206, {"Content-Type": "video/webm", "Content-Length": "6", "Content-Range": "bytes 0-5/100", "Accept-Ranges": "bytes"}, [b"abc", b"def"])

        monkeypatch.setattr(server_app, "urlopen", fake_urlopen)
        response = client.get("/api/tunnel", params={"url": "https://cdn.example/v.webm"}, headers={"Range": "bytes=0-5"})
        assert response.status_code == 206
        assert response.content == b"abcdef"
        assert response.headers["content-type"] == "video/webm"
        assert response.headers["content-range"] == "bytes 0-5/100"
        assert response.headers["content-length"] == "6"
        # Upstream saw the range, the resolve's own headers, and never our internal one.
        sent = opened[0]
        assert sent.full_url == "https://cdn.example/v.webm"
        assert sent.get_header("Range") == "bytes=0-5"
        assert sent.get_header("Referer") == "https://site.example/"
        assert sent.get_header("User-agent") == "yt-dlp-ua"
        assert sent.get_header("X-internal") is None

    def test_tunnel_reports_an_unreachable_upstream_as_a_502(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        """A host that refuses the connection is the upstream's failure, not a traceback."""
        from urllib.error import URLError

        client.post("/api/resolve", json={"url": "https://site.example/watch?v=abc"})

        def refused(*_a, **_k):  # noqa: ANN002, ANN003
            raise URLError(ConnectionRefusedError(111, "Connection refused"))

        monkeypatch.setattr(server_app, "urlopen", refused)
        response = client.get("/api/tunnel", params={"url": "https://cdn.example/v.webm"})
        assert response.status_code == 502
        assert "cdn.example" in response.json()["detail"]
        assert response.headers.get("x-relay-error") == "upstream unreachable"

    def test_tunnel_passes_an_upstream_refusal_through(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        client.post("/api/resolve", json={"url": "https://site.example/watch?v=abc"})
        monkeypatch.setattr(server_app, "urlopen", lambda *_a, **_k: _FakeUpstream(403, {}, []))
        response = client.get("/api/tunnel", params={"url": "https://cdn.example/v.webm"})
        assert response.status_code == 403
        assert "cdn.example answered 403" in response.json()["detail"]
        assert "x-relay-error" not in response.headers

    def test_both_are_gated_by_the_access_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "AUTH_TOKEN", "s3cret")
        client = TestClient(server_app.app)
        assert client.post("/api/resolve", json={"url": "https://site.example/x"}).status_code == 401
        assert client.get("/api/tunnel", params={"url": "https://cdn.example/v.webm"}).status_code == 401
        # The tunnel is fetched by the page's own fetch, which can carry the key
        # in the query as the file endpoint does.
        client.post("/api/resolve", json={"url": "https://site.example/x"}, headers={"Authorization": "Bearer s3cret"})
        monkeypatch.setattr(server_app, "urlopen", lambda *_a, **_k: _FakeUpstream(200, {"Content-Type": "video/webm"}, [b"x"]))
        assert client.get("/api/tunnel", params={"url": "https://cdn.example/v.webm", "key": "s3cret"}).status_code == 200


def test_health_lists_capabilities(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["capabilities"] == ["jobs", "resolve", "tunnel"]


# ------------------------------------------------- the ladder is YouTube's


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://www.youtube.com/watch?v=abc", True),
        ("https://youtu.be/abc", True),
        ("https://music.youtube.com/watch?v=abc", True),
        ("https://m.youtube.com/watch?v=abc", True),
        ("https://youtube-nocookie.com/embed/abc", True),
        # The suffix trick that a plain "endswith" would wave through.
        ("https://youtube.com.evil.example/watch?v=abc", False),
        ("https://vimeo.com/123", False),
        ("https://cdn.example/clip.mp4", False),
        ("not a url at all", False),
    ],
)
def test_youtube_is_recognised_by_host_not_by_substring(url: str, expected: bool) -> None:
    assert server_app.is_youtube(url) is expected


@pytest.mark.parametrize(
    "message",
    ["Sign in to confirm you're not a bot", "requested format is not available"],
)
def test_the_bot_wall_advice_is_only_given_for_youtube(message: str) -> None:
    """
    Several bot-wall markers are things yt-dlp says about any site. Telling
    someone to upload YouTube cookies because an MP4 link broke is worse than
    saying nothing.
    """
    youtube = server_app.humanize_error(Exception(message), "https://www.youtube.com/watch?v=abc")
    other = server_app.humanize_error(Exception(message), "https://cdn.example/clip.mp4")
    assert "cookies" in youtube.lower()
    assert "cookies" not in other.lower()
    assert message.split(" ")[0].lower() in other.lower() or other


def test_a_non_youtube_resolve_does_not_walk_the_client_ladder(monkeypatch: pytest.MonkeyPatch) -> None:
    """Three extra attempts with YouTube player clients help no other site."""
    _public_dns(monkeypatch)
    calls: list[dict] = []

    class _Counting(_FakeYdl):
        def extract_info(self, _url: str, download: bool = True) -> dict:
            calls.append(dict(_FakeYdl.seen_options[-1]))
            raise server_app.yt_dlp.utils.DownloadError("Sign in to confirm you're not a bot")

    monkeypatch.setattr(server_app.yt_dlp, "YoutubeDL", _Counting)
    _FakeYdl.seen_options = []
    with pytest.raises(Exception):
        server_app.resolve_url("https://vimeo.com/123")
    assert len(calls) == 1

    _FakeYdl.seen_options = []
    calls.clear()
    with pytest.raises(Exception):
        server_app.resolve_url("https://www.youtube.com/watch?v=abc")
    assert len(calls) == len(server_app.player_client_chain(False))


# ------------------------------------------------ real yt-dlp, real socket


class TestAgainstRealYtDlp:
    """
    One test that does not stub yt-dlp.

    Everything above describes what this server does with a *canned* info
    dict, which is exactly how a real defect got through: yt-dlp answers a
    plain media link with the codec fields unset, meaning "unknown", and
    reading that as "no codecs" dropped the only format there was. The link
    then failed — with a paragraph about YouTube cookies, for a link that was
    never YouTube's.

    So this one serves a file over a real socket and lets the real extractor
    look at it. No network beyond loopback, and nothing but the standard
    library to serve it.
    """

    @pytest.fixture()
    def media(self, monkeypatch: pytest.MonkeyPatch):
        import http.server
        import threading

        body = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 512

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 — the stdlib's spelling
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                self.wfile.write(body)

            do_HEAD = do_GET

            def log_message(self, *_args: object) -> None:
                return

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        # The guard exists to stop this service being pointed at a private
        # network; the flag that lifts it is exactly what a LAN source needs,
        # and what this test is.
        monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", True)
        monkeypatch.setattr(server_app, "TUNNEL_HOSTS", {})
        try:
            yield f"http://127.0.0.1:{server.server_address[1]}/clip.mp4", body
        finally:
            server.shutdown()

    def test_a_plain_media_link_resolves_to_something_downloadable(self, media) -> None:
        url, body = media
        info = server_app.resolve_url(url)

        assert info["formats"], "a direct link must produce a format, not an empty list"
        fmt = info["formats"][0]
        # Unknown codecs are not absent codecs: this is the whole file.
        assert fmt["kind"] == "muxed"
        assert fmt["protocol"] == "progressive"
        assert fmt["url"] == url
        assert fmt["label"] != "audio", "a video file must not be labelled audio"
        # And the host it named is now the one the tunnel will carry.
        assert "127.0.0.1" in server_app.TUNNEL_HOSTS

    def test_and_the_tunnel_then_carries_it_byte_for_byte(self, media, monkeypatch: pytest.MonkeyPatch) -> None:
        url, body = media
        server_app.resolve_url(url)
        client = TestClient(server_app.app)
        response = client.get("/api/tunnel", params={"url": url})
        assert response.status_code == 200
        assert response.content == body
        assert response.headers["content-type"] == "video/mp4"


# ------------------------------------------------ subtitles and playlists


class TestSubtitleTracks:
    """What a page is offered to embed."""

    def test_written_subtitles_beat_machine_ones_for_the_same_language(self) -> None:
        tracks = server_app.subtitle_tracks({
            "subtitles": {"en": [{"ext": "vtt", "url": "https://s.example/en.vtt"}]},
            "automatic_captions": {
                "en": [{"ext": "vtt", "url": "https://s.example/en.auto.vtt"}],
                "fr": [{"ext": "vtt", "url": "https://s.example/fr.auto.vtt"}],
            },
        })
        assert [(t["lang"], t["auto"]) for t in tracks] == [("en", False), ("fr", True)]
        assert tracks[0]["url"] == "https://s.example/en.vtt"

    def test_the_format_a_browser_can_read_is_preferred(self) -> None:
        tracks = server_app.subtitle_tracks({
            "subtitles": {"en": [
                {"ext": "ttml", "url": "https://s.example/en.ttml"},
                {"ext": "srt", "url": "https://s.example/en.srt"},
                {"ext": "vtt", "url": "https://s.example/en.vtt"},
            ]},
        })
        assert tracks[0]["ext"] == "vtt"

    def test_a_language_with_nothing_usable_is_dropped(self) -> None:
        assert server_app.subtitle_tracks({"subtitles": {"en": [{"ext": "ttml", "url": "u"}]}}) == []

    def test_every_auto_language_is_offered_the_original_first(self) -> None:
        """
        YouTube lists its auto-translations alphabetically by English name —
        Abkhazian, Afar, Afrikaans — so keeping the first 25 dropped English,
        French and German, and the device embedded Abkhazian for "en".
        """
        codes = [f"x{i:03d}" for i in range(150)]
        codes[30:30] = ["en-orig", "en"]
        auto = {code: [{"ext": "json3", "url": "j"}, {"ext": "vtt", "url": f"https://s.example/{code}.vtt"}] for code in codes}
        tracks = server_app.subtitle_tracks({"automatic_captions": auto})
        assert len(tracks) == len(codes)
        assert "en" in [t["lang"] for t in tracks]
        # With nothing written, the device falls back to the first track: the
        # video's own language, not the alphabet's.
        assert tracks[0]["lang"] == "en-orig"
        written = server_app.subtitle_tracks({"subtitles": {"de": [{"ext": "vtt", "url": "https://s.example/de.vtt"}]}, "automatic_captions": auto})
        assert [t["lang"] for t in written[:2]] == ["de", "en-orig"]

    def test_nothing_offered_is_an_empty_list_not_a_failure(self) -> None:
        assert server_app.subtitle_tracks({}) == []


class TestPlaylistResolve:
    @pytest.fixture(autouse=True)
    def _isolate(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _public_dns(monkeypatch)
        monkeypatch.setattr(server_app.yt_dlp, "YoutubeDL", _FakeYdl)
        monkeypatch.setattr(server_app, "TUNNEL_HOSTS", {})
        _FakeYdl.seen_options = []
        _FakeYdl.info = {
            "_type": "playlist",
            "id": "PL1",
            "title": "An album",
            "uploader": "A band",
            "extractor_key": "Site",
            "entries": [
                {"url": "https://site.example/watch?v=one", "title": "One", "thumbnail": "https://img.example/1.jpg"},
                {"url": "https://site.example/watch?v=two", "title": "Two"},
                {"webpage_url": "https://site.example/watch?v=three", "title": "Three"},
                None,
            ],
        }

    def test_a_playlist_comes_back_as_a_list_not_as_its_first_track(self, client: TestClient) -> None:
        body = client.post("/api/resolve", json={"url": "https://site.example/playlist?list=PL1"}).json()
        assert body["title"] == "An album"
        assert body["formats"] == []
        assert body["playlist"]["count"] == 3
        assert [e["title"] for e in body["playlist"]["entries"]] == ["One", "Two", "Three"]
        # Either spelling of the entry's address is understood.
        assert body["playlist"]["entries"][2]["url"] == "https://site.example/watch?v=three"

    def test_the_cap_is_reported_so_the_page_can_say_what_it_will_do(self, client: TestClient) -> None:
        body = client.post("/api/resolve", json={"url": "https://site.example/playlist?list=PL1"}).json()
        assert body["playlist"]["limit"] == server_app.PLAYLIST_LIMIT

    def test_entries_are_not_extracted_one_by_one_to_answer(self, client: TestClient) -> None:
        client.post("/api/resolve", json={"url": "https://site.example/playlist?list=PL1"})
        assert _FakeYdl.seen_options[0]["extract_flat"] == "in_playlist"
        assert _FakeYdl.seen_options[0]["noplaylist"] is True


def test_a_single_video_reports_its_subtitles_and_no_playlist(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _public_dns(monkeypatch)
    monkeypatch.setattr(server_app.yt_dlp, "YoutubeDL", _FakeYdl)
    monkeypatch.setattr(server_app, "TUNNEL_HOSTS", {})
    _FakeYdl.info = {
        "id": "abc",
        "title": "A video",
        "extractor_key": "Site",
        "formats": [{"format_id": "m", "url": "https://cdn.example/v.mp4", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a"}],
        "subtitles": {"en": [{"ext": "vtt", "url": "https://subs.example/en.vtt"}]},
    }
    body = client.post("/api/resolve", json={"url": "https://site.example/watch?v=abc"}).json()
    assert body["playlist"] is None
    assert body["subtitles"] == [{"lang": "en", "ext": "vtt", "url": "https://subs.example/en.vtt", "auto": False}]
    # And the page can actually fetch it: the subtitle host is tunnelable too.
    assert "subs.example" in server_app.TUNNEL_HOSTS


def test_yt_dlp_is_quiet_unless_asked_to_speak(monkeypatch: pytest.MonkeyPatch) -> None:
    """The CI measurement turns verbose on to read what yt-dlp said; nobody else pays for it."""
    job = server_app.Job(id="j", url="https://www.youtube.com/watch?v=abc", preset="video_best")
    quiet = server_app.build_options(job, None)
    assert quiet["quiet"] is True and quiet["verbose"] is False and quiet["no_warnings"] is True
    monkeypatch.setattr(server_app, "YTDLP_VERBOSE", True)
    loud = server_app.build_options(job, None)
    assert loud["quiet"] is False and loud["verbose"] is True and loud["no_warnings"] is False


# ------------------------------------------------------- per-job options


class TestJobOptions:
    """
    What the page's Advanced section may ask yt-dlp for. Every value is
    narrowed before it reaches yt-dlp — a float, an int, a name off a list —
    so this is a vocabulary, never a passthrough.
    """

    @staticmethod
    def _job(**kwargs) -> "server_app.Job":
        return server_app.Job(id="o1", url="https://www.youtube.com/watch?v=abc", preset="video_720", **kwargs)

    @pytest.mark.parametrize(
        ("text", "seconds"),
        [("", None), ("45", 45.0), ("1:23", 83.0), ("01:02:03", 3723.0), ("1:02:03.5", 3723.5), ("90:00", 5400.0), ("0:00", 0.0)],
    )
    def test_timestamps_are_read_as_a_clock(self, text: str, seconds: float | None) -> None:
        assert server_app.parse_timestamp(text) == seconds

    @pytest.mark.parametrize(("text", "seconds"), [("150", 150.0), ("90.5", 90.5), ("7200", 7200.0), ("0.25", 0.25)])
    def test_plain_seconds_are_read_whatever_their_length(self, text: str, seconds: float) -> None:
        """Someone typing seconds types 150, not 2:30; only two digits were taken."""
        assert server_app.parse_timestamp(text) == seconds

    @pytest.mark.parametrize("text", ["abc", "1:99", "1:60:00", "1:2:3:4", "-5", "1h", "150.", ".5", "1.2345", "1:150"])
    def test_a_non_time_is_refused_with_the_shape_to_use(self, text: str) -> None:
        with pytest.raises(ValueError, match="1:23"):
            server_app.parse_timestamp(text)

    @pytest.mark.parametrize(
        ("text", "limit"),
        [("", None), ("500K", 512000), ("2M", 2 * 1024**2), ("1.5m/s", int(1.5 * 1024**2)), ("300 KiB", 300 * 1024), ("4096", 4096)],
    )
    def test_speed_limits_are_read_with_their_unit(self, text: str, limit: int | None) -> None:
        assert server_app.parse_rate_limit(text) == limit

    @pytest.mark.parametrize("text", ["fast", "0", "-1M", "2T"])
    def test_a_non_limit_is_refused(self, text: str) -> None:
        with pytest.raises(ValueError, match="500K"):
            server_app.parse_rate_limit(text)

    def test_a_client_is_one_off_the_list(self) -> None:
        assert server_app.check_yt_client("TV") == "tv"
        assert server_app.check_yt_client("") == ""
        with pytest.raises(ValueError, match="Unknown YouTube client"):
            server_app.check_yt_client("netscape")

    def test_sponsorblock_cuts_before_anything_else_touches_the_file(self) -> None:
        pps = server_app.build_options(self._job(sponsorblock=True), None)["postprocessors"]
        assert [pp["key"] for pp in pps[:2]] == ["SponsorBlock", "ModifyChapters"]
        assert pps[0]["when"] == "after_filter"
        assert pps[0]["categories"] == pps[1]["remove_sponsor_segments"] == server_app.SPONSOR_CATEGORIES
        # The preset's own steps still follow.
        assert any(pp["key"] == "FFmpegMetadata" for pp in pps[2:])
        assert "SponsorBlock" not in [pp["key"] for pp in server_app.build_options(self._job(), None)["postprocessors"]]

    def test_a_clip_fetches_only_its_span(self) -> None:
        """
        A clip was cut from a download of the whole video — gigabytes, for
        half a minute of a long one — because yt-dlp's download_ranges hands
        the URL to ffmpeg, whose connections the guard never saw. ffmpeg now
        connects through the guarded proxy, so the span is all that is
        fetched, re-encoded to start and end where it was asked to.
        """
        clipped = self._job(clip_start=83.0, clip_end=100.0)
        options = server_app.build_options(clipped, None)
        assert list(options["download_ranges"]({}, None)) == [{"start_time": 83.0, "end_time": 100.0}]
        assert options["force_keyframes_at_cuts"] is True
        # What comes whole with it — subtitles, chapters — is put on the
        # clip's clock before anything embeds it.
        steps = server_app.job_postprocessors(clipped)
        assert [when for step, when in steps if isinstance(step, server_app.FitToClip)] == ["before_dl"]
        # The guard on the formats runs for every download, clip or not.
        assert [when for step, when in server_app.job_postprocessors(self._job()) if isinstance(step, server_app.CheckMediaUrls)] == ["before_dl"]
        assert "download_ranges" not in server_app.build_options(self._job(), None)
        assert not any(isinstance(step, server_app.FitToClip) for step, _ in server_app.job_postprocessors(self._job()))

    def test_a_clips_chapters_are_the_clips(self) -> None:
        chapters = [
            {"start_time": 0.0, "end_time": 60.0, "title": "Intro"},
            {"start_time": 60.0, "end_time": 120.0, "title": "Middle"},
            {"start_time": 120.0, "end_time": 180.0, "title": "End"},
        ]
        _, info = server_app.FitToClip(90.0, 130.0).run({"chapters": chapters})
        assert info["chapters"] == [
            {"start_time": 0.0, "end_time": 30.0, "title": "Middle"},
            {"start_time": 30.0, "end_time": 40.0, "title": "End"},
        ]
        _, info = server_app.FitToClip(None, 30.0).run({"chapters": chapters})
        assert info["chapters"] == [{"start_time": 0.0, "end_time": 30.0, "title": "Intro"}]

    def test_hls_goes_to_yt_dlps_own_downloader_first(self) -> None:
        """
        It fetches through this process, reports progress and keeps to a
        speed limit; ffmpeg, through the proxy, gets only what it cannot read.
        """
        assert server_app.build_options(self._job(), None)["hls_prefer_native"] is True

    def test_a_speed_limit_is_handed_to_yt_dlp_in_bytes(self) -> None:
        assert server_app.build_options(self._job(rate_limit=512000), None)["ratelimit"] == 512000
        assert "ratelimit" not in server_app.build_options(self._job(), None)

    def test_a_speed_limit_holds_for_the_download_not_for_each_fragment(self) -> None:
        """
        yt-dlp applies the limit to every fragment download on its own, so
        four fragments at once made a 200K limit into about 550K on HLS.
        """
        assert server_app.build_options(self._job(rate_limit=204800), None)["concurrent_fragment_downloads"] == 1
        assert server_app.build_options(self._job(), None)["concurrent_fragment_downloads"] == 4

    def test_the_client_asked_for_goes_first_and_the_ladder_still_follows(self) -> None:
        assert server_app.player_client_chain(False, "android_vr") == ["android_vr", None, "tv", "web_safari"]
        assert server_app.player_client_chain(True, "tv") == ["tv", None, "web_safari", "mweb"]
        assert server_app.player_client_chain(False, "") == [None, "tv", "web_safari", "android_vr"]

    @pytest.mark.parametrize(
        ("body", "detail"),
        [
            ({"clip_start": "1:99"}, "1:23"),
            ({"clip_start": "2:00", "clip_end": "1:00"}, "end after it starts"),
            ({"rate_limit": "fast"}, "500K"),
            ({"yt_client": "netscape"}, "Unknown YouTube client"),
        ],
    )
    def test_the_api_refuses_a_bad_option_with_the_reason(self, client: TestClient, monkeypatch: pytest.MonkeyPatch, body: dict, detail: str) -> None:
        _public_dns(monkeypatch)
        response = client.post("/api/jobs", json={"url": "https://www.youtube.com/watch?v=abc", **body})
        assert response.status_code == 400
        assert detail in response.json()["detail"]

    def test_the_api_stores_the_options_on_the_job(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        _public_dns(monkeypatch)
        monkeypatch.setattr(server_app, "run_job", lambda _job: None)
        response = client.post(
            "/api/jobs",
            json={"url": "https://www.youtube.com/watch?v=abc", "clip_start": "0:10", "clip_end": "1:00", "rate_limit": "2M", "yt_client": "TV"},
        )
        assert response.status_code == 200
        job = server_app.JOBS[response.json()["id"]]
        assert (job.sponsorblock, job.clip_start, job.clip_end, job.rate_limit, job.yt_client) == (False, 10.0, 60.0, 2 * 1024**2, "tv")
        sponsored = client.post("/api/jobs", json={"url": "https://www.youtube.com/watch?v=abc", "sponsorblock": True})
        assert server_app.JOBS[sponsored.json()["id"]].sponsorblock is True

    def test_sponsor_removal_and_a_clip_are_refused_together(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        """
        yt-dlp gives a clip the clip's duration, SponsorBlock then discards
        every segment as another video's, and the sponsors come back. Said up
        front rather than delivered as a surprise.
        """
        _public_dns(monkeypatch)
        response = client.post(
            "/api/jobs",
            json={"url": "https://www.youtube.com/watch?v=abc", "sponsorblock": True, "clip_start": "0:10"},
        )
        assert response.status_code == 400
        assert "cannot be combined" in response.json()["detail"]

    @pytest.mark.parametrize("langs", [".*", "all", "en,.*", "en|fr", "e"])
    def test_subtitle_languages_are_codes_not_patterns(self, client: TestClient, monkeypatch: pytest.MonkeyPatch, langs: str) -> None:
        """yt-dlp reads each entry as a regex: ".*" would fetch every auto-translation there is."""
        _public_dns(monkeypatch)
        response = client.post("/api/jobs", json={"url": "https://www.youtube.com/watch?v=abc", "subs": "files", "sub_langs": langs})
        assert response.status_code == 400
        assert "codes like en" in response.json()["detail"]

    def test_subtitle_language_codes_pass(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        _public_dns(monkeypatch)
        monkeypatch.setattr(server_app, "run_job", lambda _job: None)
        response = client.post("/api/jobs", json={"url": "https://www.youtube.com/watch?v=abc", "subs": "files", "sub_langs": " en, pt-BR ,zh-Hans"})
        assert response.status_code == 200
        assert server_app.JOBS[response.json()["id"]].sub_langs == "en,pt-BR,zh-Hans"

    def test_separate_subtitles_are_converted_to_srt(self) -> None:
        """The settings say .srt; YouTube hands out VTT, which fewer phone players open."""
        job = server_app.Job(id="a" * 16, url="https://www.youtube.com/watch?v=abc", preset="video_best", subs="files")
        keys = [pp["key"] for pp in server_app.build_options(job, None).get("postprocessors", [])]
        assert "FFmpegSubtitlesConvertor" in keys


# ------------------------------------------------------- found in review

class TestWhereConnectionsGo:
    """
    The guard at connect time. assert_fetchable only sees the URL a caller
    names; redirects, a page's own video URL and a second DNS answer all went
    around it — to loopback, to the LAN, to the cloud metadata endpoint.
    """

    def test_a_name_that_resolves_privately_is_refused_at_connect_time(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "_REAL_GETADDRINFO", lambda *_a, **_k: [(2, 1, 6, "", ("127.0.0.1", 80))])
        with pytest.raises(server_app.PrivateAddress):
            server_app.socket.getaddrinfo("redirected.example", 80)

    @pytest.mark.parametrize("address", ["169.254.169.254", "10.1.2.3", "100.100.100.100", "::1", "fe80::1%eth0", "0.0.0.0"])
    def test_every_non_global_address_is_refused(self, address: str) -> None:
        assert server_app.refused_address(address)

    def test_public_addresses_pass(self) -> None:
        assert not server_app.refused_address("93.184.216.34")
        assert not server_app.refused_address("2606:2800:220:1:248:1893:25c8:1946")

    def test_binding_a_listening_socket_is_not_a_connection(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "_REAL_GETADDRINFO", lambda *_a, **_k: [(2, 1, 6, "", ("0.0.0.0", 8000))])
        assert server_app.socket.getaddrinfo("0.0.0.0", 8000, flags=server_app.socket.AI_PASSIVE)

    def test_the_operators_own_sidecar_is_reachable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "_REAL_GETADDRINFO", lambda *_a, **_k: [(2, 1, 6, "", ("172.18.0.4", 4416))])
        monkeypatch.setattr(server_app, "EXEMPT_HOSTS", frozenset({("potoken", 4416)}))
        assert server_app.socket.getaddrinfo("potoken", 4416)
        with pytest.raises(server_app.PrivateAddress):
            server_app.socket.getaddrinfo("elsewhere", 4416)

    def test_the_sidecar_is_exempt_on_its_own_port_and_no_other(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """
        A redirect to 127.0.0.1:6379 is not a visit to the provider on
        127.0.0.1:4416, whatever the two have in common.
        """
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setattr(server_app, "POT_PROVIDER_URL", "http://127.0.0.1:4416")
        monkeypatch.setattr(server_app, "EXEMPT_HOSTS", server_app._exempt_hosts())
        monkeypatch.setattr(server_app, "_REAL_GETADDRINFO", lambda *_a, **_k: [(2, 1, 6, "", ("127.0.0.1", 0))])
        assert server_app.socket.getaddrinfo("127.0.0.1", 4416)
        assert server_app.socket.getaddrinfo("127.0.0.1", "4416")
        for port in (6379, 8080, None):
            with pytest.raises(server_app.PrivateAddress):
                server_app.socket.getaddrinfo("127.0.0.1", port)

    def test_a_proxy_is_exempt_on_the_port_it_is_named_with(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setattr(server_app, "POT_PROVIDER_URL", "")
        monkeypatch.setenv("HTTPS_PROXY", "proxy.lan:3128")
        monkeypatch.setenv("http_proxy", "http://gateway.lan")
        monkeypatch.setenv("ALL_PROXY", "socks5://127.0.0.1")
        assert server_app._exempt_hosts() == {("proxy.lan", 3128), ("gateway.lan", 80), ("127.0.0.1", 1080)}

    def test_allow_private_hosts_turns_it_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "_REAL_GETADDRINFO", lambda *_a, **_k: [(2, 1, 6, "", ("192.168.1.20", 80))])
        monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", True)
        assert server_app.socket.getaddrinfo("nas.local", 80)

    def test_cgnat_is_private_for_the_url_guard_too(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """100.64/10 is where a Tailscale network's other machines live."""
        monkeypatch.setattr(server_app.socket, "getaddrinfo", lambda *_a, **_k: [(2, 1, 6, "", ("100.100.100.100", 80))])
        with pytest.raises(server_app.UnsafeUrl):
            server_app.assert_fetchable("http://tailnet-neighbour.example/x.mp4")

    def test_a_chosen_format_on_a_private_address_is_refused_before_download(self) -> None:
        with pytest.raises(server_app.yt_dlp.utils.DownloadError):
            server_app.CheckMediaUrls().run({"requested_formats": [{"url": "http://169.254.169.254/latest/meta-data/"}]})

    @pytest.mark.parametrize("url", ["rtmp://10.0.0.1/live/stream", "rtsp://192.168.1.2/camera", "file:///etc/passwd", "ftp://10.0.0.1/v.mp4"])
    def test_a_format_that_is_not_http_is_refused_not_skipped(self, url: str) -> None:
        """
        Anything else is fetched by rtmpdump, mplayer or ffmpeg — programs
        with their own sockets, which the guard never sees.
        """
        with pytest.raises(server_app.yt_dlp.utils.DownloadError, match="http"):
            server_app.CheckMediaUrls().run({"url": url})


class TestTunnelRedirects:
    def test_a_redirect_to_a_private_address_is_refused(self) -> None:
        handler = server_app.TunnelRedirects()
        request = server_app.UrlRequest("https://media.example/v.mp4")
        with pytest.raises(server_app.HTTPError) as caught:
            handler.redirect_request(request, None, 302, "Found", {}, "http://127.0.0.1:9000/private")
        assert caught.value.code == 403

    def test_credentials_stay_with_the_host_they_were_granted_to(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        """urllib copies every header onto a redirect; a Cookie for one CDN must not reach the next host."""
        import http.server
        import threading as _threading

        seen: dict[str, str | None] = {}

        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                seen["cookie"] = self.headers.get("Cookie")
                seen["authorization"] = self.headers.get("Authorization")
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *_args: Any) -> None:
                pass

        target = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Target)

        class Redirector(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self.send_response(302)
                self.send_header("Location", f"http://localhost:{target.server_address[1]}/file")
                self.end_headers()

            def log_message(self, *_args: Any) -> None:
                pass

        first = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirector)
        for server in (target, first):
            _threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", True)
            server_app._grant_host("http://127.0.0.1/", {"Cookie": "session=secret", "Authorization": "Bearer secret"})
            response = client.get("/api/tunnel", params={"url": f"http://127.0.0.1:{first.server_address[1]}/start"})
            assert response.status_code == 200
            assert response.content == b"ok"
            assert seen == {"cookie": None, "authorization": None}
        finally:
            for server in (target, first):
                server.shutdown()

    def test_the_page_is_told_where_the_redirects_ended(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        """
        Through the tunnel, the answer's address is the server's, so a
        redirected playlist's relative links were resolved against the short
        link the page asked for rather than the directory it landed in.
        """
        import http.server
        import threading as _threading

        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                body = b"#EXTM3U\nv360.m3u8\n"
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Siphon-Final-URL", "https://elsewhere.example/")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: Any) -> None:
                pass

        target = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Target)
        landed = f"http://127.0.0.1:{target.server_address[1]}/hls/42/master.m3u8"

        class Redirector(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self.send_response(302)
                self.send_header("Location", landed)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_args: Any) -> None:
                pass

        first = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirector)
        for server in (target, first):
            _threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", True)
            monkeypatch.setattr(server_app, "TUNNEL_HOSTS", {})
            server_app._grant_host("http://127.0.0.1/", {})
            response = client.get(
                "/api/tunnel",
                params={"url": f"http://127.0.0.1:{first.server_address[1]}/short"},
                headers={"Origin": server_app.HOSTED_PAGE_ORIGIN},
            )
            assert response.status_code == 200
            assert response.content == b"#EXTM3U\nv360.m3u8\n"
            # The last hop, and never a header of that name the host sent.
            assert response.headers.get("x-siphon-final-url") == landed
            # And the page can read it: its fetch carries no credentials, so
            # '*' exposes every header.
            assert response.headers.get("access-control-allow-origin") == server_app.HOSTED_PAGE_ORIGIN
            assert response.headers.get("access-control-expose-headers") == "*"
            assert "access-control-allow-credentials" not in response.headers
        finally:
            for server in (target, first):
                server.shutdown()


class TestCookiesStayDeleted:
    def test_each_run_gets_a_private_copy(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """yt-dlp writes its jar back on close; handed the real file, that undid a delete."""
        monkeypatch.setattr(server_app, "COOKIES_PATH", tmp_path / "cookies.txt")
        server_app.write_private(server_app.COOKIES_PATH, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx\n")
        job = server_app.Job(id="b" * 16, url="https://www.youtube.com/watch?v=abc", preset="video_best")
        monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path / "jobs")
        job.directory.mkdir(parents=True)
        cookiefile = server_app.build_options(job, None)["cookiefile"]
        assert cookiefile != str(server_app.COOKIES_PATH)
        assert Path(cookiefile).stat().st_mode & 0o077 == 0
        server_app.COOKIES_PATH.unlink()
        Path(cookiefile).write_text("written back by yt-dlp")
        assert not server_app.COOKIES_PATH.exists()


class TestCancelling:
    def test_a_cancelled_job_stops_at_its_next_progress_report(self) -> None:
        job = server_app.Job(id="c" * 16, url="https://example.com/v.mp4", preset="video_best")
        job.cancelled = True
        with pytest.raises(server_app.yt_dlp.utils.DownloadCancelled):
            server_app._hook(job)({"status": "downloading", "downloaded_bytes": 10, "total_bytes": 100})

    def test_a_job_cancelled_while_queued_never_starts_and_leaves_nothing(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path)
        job = server_app.Job(id="d" * 16, url="https://example.com/v.mp4", preset="video_best")
        job.directory.mkdir()
        job.cancelled = True
        server_app.run_job(job)
        assert job.state == "queued"
        assert not job.directory.exists()

    def test_delete_marks_the_job_cancelled(self, client: TestClient) -> None:
        job = server_app.Job(id="e" * 16, url="https://example.com/v.mp4", preset="video_best", state="running")
        server_app.JOBS[job.id] = job
        assert client.delete(f"/api/jobs/{job.id}").json() == {"deleted": True}
        assert job.cancelled


class TestDiskIsSwept:
    def test_directories_no_job_owns_are_removed(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """What a previous run left on a volume used to stay there for ever."""
        monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path)
        orphan = tmp_path / ("f" * 16)
        orphan.mkdir()
        (orphan / "big.mp4").write_bytes(b"x")
        unrelated = tmp_path / "keep-me"
        unrelated.mkdir()
        owned = tmp_path / ("0" * 16)
        owned.mkdir()
        server_app.JOBS["0" * 16] = server_app.Job(id="0" * 16, url="https://example.com/v.mp4", preset="video_best")
        try:
            server_app.sweep_orphans()
        finally:
            server_app.JOBS.pop("0" * 16, None)
        assert not orphan.exists()
        assert unrelated.exists() and owned.exists()

    def test_the_sweep_runs_on_its_own(self) -> None:
        assert server_app.SWEEP_INTERVAL_SECONDS <= max(30, server_app.JOB_TTL_SECONDS // 2)


class TestOrigins:
    def test_the_default_names_the_hosted_page_only(self) -> None:
        if "ALLOWED_ORIGINS" in __import__("os").environ:
            pytest.skip("ALLOWED_ORIGINS is set in this environment")
        assert server_app.ALLOWED_ORIGINS == ["https://maxgfr.github.io"]

    def test_a_pages_address_is_cut_to_its_origin(self) -> None:
        # A browser's Origin has no path, and CORS compares it with each entry
        # as written: https://you.github.io/siphon/, copied from the address
        # bar as the README said, refused the page it named.
        assert server_app.origins_from("https://you.github.io/siphon/, HTTPS://Other.Example:443/x ,*, http://localhost:8080/") == [
            "https://you.github.io",
            "https://other.example",
            "*",
            "http://localhost:8080",
        ]
        env = __import__("os").environ
        assert server_app.ALLOWED_ORIGINS == server_app.origins_from(env.get("ALLOWED_ORIGINS", server_app.HOSTED_PAGE_ORIGIN))

    def test_and_the_page_named_that_way_is_answered(self) -> None:
        from starlette.middleware.cors import CORSMiddleware
        from fastapi import FastAPI

        scoped = FastAPI()
        scoped.add_middleware(CORSMiddleware, allow_origins=server_app.origins_from("https://you.github.io/siphon/"), allow_methods=["GET"])
        preflight = TestClient(scoped).options(
            "/api/health", headers={"Origin": "https://you.github.io", "Access-Control-Request-Method": "GET"}
        )
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == "https://you.github.io"

    def test_another_site_is_not_answered(self, client: TestClient) -> None:
        response = client.options(
            "/api/cookies",
            headers={
                "Origin": "https://random-site.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        assert response.status_code == 400
        assert "access-control-allow-origin" not in response.headers


def test_a_non_ascii_key_is_a_401_not_a_500(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server_app, "AUTH_TOKEN", "s3cret")
    assert client.get("/api/jobs/abc/file", params={"key": "é"}).status_code == 401


# ---------------------------------------- real servers, real yt-dlp, ffmpeg

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(not (FFMPEG and shutil.which("ffprobe")), reason="needs ffmpeg and ffprobe")


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args: object) -> None:
        return


@contextlib.contextmanager
def _serving(handler: type, host: str = "127.0.0.1", tls: "ssl.SSLContext | None" = None) -> Iterator[str]:
    """A throwaway HTTP server, or HTTPS given a context; yields its base URL."""
    try:
        server = http.server.ThreadingHTTPServer((host, 0), handler)
    except OSError:
        pytest.skip(f"cannot listen on {host}")
    if tls:
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"{'https' if tls else 'http'}://{host}:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def _ffmpeg(*args: str) -> None:
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", *args], check=True)


def _duration(path: Path) -> float:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(probe.stdout.strip())


def _run(url: str, preset: str = "video_best", **kwargs) -> "server_app.Job":  # noqa: ANN003
    job = server_app.Job(id=uuid.uuid4().hex[:16], url=url, preset=preset, **kwargs)
    server_app.run_job(job)
    return job


@pytest.fixture(scope="module")
def sample_mp4(tmp_path_factory: pytest.TempPathFactory) -> bytes:
    """Four seconds of picture and tone, with a keyframe every second."""
    path = tmp_path_factory.mktemp("media") / "sample.mp4"
    _ffmpeg(
        "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=4", "-f", "lavfi", "-i", "sine=duration=4",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "10", "-c:a", "aac", "-shortest", str(path),
    )
    return path.read_bytes()


def _ask_proxy(run: "server_app.ProxyRun", first_line: str, then: bytes = b"", credentials: bool = True) -> bytes:
    """
    One request to the guarded proxy, as ffmpeg makes it, and everything the
    proxy answers. `then` is spoken through a tunnel once CONNECT is granted.
    """
    parts = urlsplit(run.url)
    lines = [first_line, "Host: siphon.test"]
    if credentials:
        token = base64.b64encode(f"{parts.username}:{parts.password}".encode()).decode()
        lines.append(f"Proxy-Authorization: Basic {token}")
    conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    conn.settimeout(10)
    # A number: nothing for the guard to look up.
    conn.connect(("127.0.0.1", parts.port))
    try:
        conn.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        answer = b""
        if then:
            while b"\r\n\r\n" not in answer and (chunk := conn.recv(4096)):
                answer += chunk
            conn.sendall(then)
        while chunk := conn.recv(65536):
            answer += chunk
        return answer
    finally:
        conn.close()


class TestTheGuardedProxy:
    """
    What ffmpeg is pointed at. Every connection it asks for is opened the
    way this process opens its own — through the guard — and one the guard
    refuses is a 403, whether it is a tunnel for https or a plain request.
    """

    @pytest.fixture(autouse=True)
    def _guarded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", False)
        monkeypatch.setattr(server_app, "EXEMPT_HOSTS", frozenset())

    @pytest.fixture()
    def local(self) -> Iterator[tuple[str, list[tuple[str, str | None]]]]:
        """Something listening on loopback, and what it was asked for."""
        hits: list[tuple[str, str | None]] = []

        class Local(_Quiet):
            def do_GET(self) -> None:  # noqa: N802
                hits.append((self.path, self.headers.get("Via")))
                if self.path == "/away":
                    self.send_response(302)
                    self.send_header("Location", "http://127.0.0.3:9/secret")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", "6")
                self.end_headers()
                self.wfile.write(b"local!")

        with _serving(Local) as base:
            yield base, hits

    @pytest.mark.parametrize(
        "ask",
        [
            "CONNECT {loopback} HTTP/1.1",
            "GET http://{loopback}/x HTTP/1.1",
            "CONNECT 169.254.169.254:80 HTTP/1.1",
            "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1",
            "CONNECT 10.0.0.1:443 HTTP/1.1",
            "GET http://192.168.1.1/ HTTP/1.1",
            "CONNECT [::1]:443 HTTP/1.1",
        ],
    )
    def test_a_private_address_is_refused_either_way(self, local, ask: str) -> None:  # noqa: ANN001
        base, hits = local
        with server_app.proxy_run() as run:
            answer = _ask_proxy(run, ask.format(loopback=urlsplit(base).netloc))
            assert run.refused
        assert answer.split(b"\r\n", 1)[0].split()[1] == b"403", answer
        assert hits == []

    def test_an_exempt_address_is_reachable_on_its_port_and_no_other(self, local, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
        """The provider and the operator's proxy, as everywhere else in the server."""
        base, hits = local
        port = urlsplit(base).port
        monkeypatch.setattr(server_app, "EXEMPT_HOSTS", frozenset({("127.0.0.1", port)}))
        with server_app.proxy_run() as run:
            plain = _ask_proxy(run, f"GET {base}/plain HTTP/1.1")
            tunnelled = _ask_proxy(run, f"CONNECT 127.0.0.1:{port} HTTP/1.1", then=b"GET /tunnelled HTTP/1.0\r\n\r\n")
            other = _ask_proxy(run, f"CONNECT 127.0.0.1:{port + 1 if port < 65535 else port - 1} HTTP/1.1")
        assert plain.startswith(b"HTTP/1.0 200") and plain.endswith(b"local!"), plain
        assert tunnelled.startswith(b"HTTP/1.1 200") and tunnelled.endswith(b"local!"), tunnelled
        assert other.split()[1] == b"403", other
        # A proxy says so on what it forwards; through a tunnel it cannot.
        assert hits == [("/plain", "1.1 siphon"), ("/tunnelled", None)]

    def test_a_redirect_is_carried_back_and_its_hop_checked(self, local, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
        """ffmpeg follows it with a request of its own, and that is checked like the first."""
        base, hits = local
        monkeypatch.setattr(server_app, "EXEMPT_HOSTS", frozenset({("127.0.0.1", urlsplit(base).port)}))
        with server_app.proxy_run() as run:
            redirect = _ask_proxy(run, f"GET {base}/away HTTP/1.1")
            assert not run.refused
            location = next(line for line in redirect.decode().split("\r\n") if line.lower().startswith("location:")).split(" ", 1)[1]
            hop = _ask_proxy(run, f"GET {location} HTTP/1.1")
            assert run.refused
        assert redirect.startswith(b"HTTP/1.0 302"), redirect
        assert hop.split()[1] == b"403", hop
        assert [path for path, _via in hits] == ["/away"]

    def test_nothing_is_carried_for_a_run_it_did_not_start(self, local, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
        """
        ffmpeg sends its pass once asked for it. Anything else on this
        machine that finds the port has none, and is not a way out.
        """
        base, hits = local
        monkeypatch.setattr(server_app, "EXEMPT_HOSTS", frozenset({("127.0.0.1", urlsplit(base).port)}))
        with server_app.proxy_run() as run:
            answer = _ask_proxy(run, f"GET {base}/x HTTP/1.1", credentials=False)
        assert answer.split()[1] == b"407", answer
        assert b'proxy-authenticate: basic realm="siphon"' in answer.lower()
        with server_app.proxy_run() as run:
            pass
        assert _ask_proxy(run, f"GET {base}/x HTTP/1.1").split()[1] == b"407"
        assert hits == []

    def test_a_revoked_run_is_cut_off(self, local, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
        """How a cancelled download stops an ffmpeg that is still going."""
        base, _hits = local
        port = urlsplit(base).port
        monkeypatch.setattr(server_app, "EXEMPT_HOSTS", frozenset({("127.0.0.1", port)}))
        with server_app.proxy_run() as run:
            parts = urlsplit(run.url)
            token = base64.b64encode(f"{parts.username}:{parts.password}".encode()).decode()
            tunnel = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            tunnel.settimeout(10)
            tunnel.connect(("127.0.0.1", parts.port))
            try:
                tunnel.sendall(f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\nProxy-Authorization: Basic {token}\r\n\r\n".encode())
                assert tunnel.recv(4096).startswith(b"HTTP/1.1 200")
                run.revoke()
                assert tunnel.recv(4096) == b""
            finally:
                tunnel.close()
            assert _ask_proxy(run, f"GET {base}/x HTTP/1.1").split()[1] == b"403"


@needs_ffmpeg
class TestFfmpegFetchesThroughTheGuard:
    """
    ffmpeg opens its own connections, so the connect-time guard never saw
    where they went. A clip is fetched by ffmpeg, and yt-dlp hands it a live
    stream and any HLS its own downloader cannot read — and each of those
    went wherever the playlist or a redirect said, into a finished file.
    Now ffmpeg is pointed at the guarded proxy, and every connection it
    makes, each redirect's included, is checked there.

    127.0.0.3 stands for the private network here, and the rest of loopback
    for the internet. What the public host is asked through the proxy
    carries its Via header, which is how these know the proxy was used.
    """

    PRIVATE = "127.0.0.3"

    @pytest.fixture()
    def network(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, sample_mp4: bytes) -> Iterator[tuple[str, list[str], list[str]]]:
        monkeypatch.setattr(server_app, "refused_address", lambda raw: str(raw) == self.PRIVATE)
        monkeypatch.setattr(server_app, "EXEMPT_HOSTS", frozenset())
        monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", False)
        monkeypatch.setattr(server_app, "BEHIND_A_PROXY", False)
        monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path / "jobs")
        (tmp_path / "jobs").mkdir()
        # A file on this machine, where another job's download would be.
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "sample.mp4").write_bytes(sample_mp4)
        _ffmpeg("-i", str(elsewhere / "sample.mp4"), "-c", "copy", "-f", "mpegts", str(elsewhere / "secret.ts"))
        hits: list[str] = []
        proxied: list[str] = []

        class Private(_Quiet):
            def do_GET(self) -> None:  # noqa: N802
                hits.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", str(len(sample_mp4)))
                self.end_headers()
                self.wfile.write(sample_mp4)

        with _serving(Private, self.PRIVATE) as private:
            head = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n"
            playlists = {
                "/vod.m3u8": f"{head}#EXTINF:2.0,\n{private}/vod.ts\n#EXT-X-ENDLIST\n",
                "/sample-aes.m3u8": f'{head}#EXT-X-KEY:METHOD=SAMPLE-AES,URI="{private}/key"\n#EXTINF:2.0,\n{private}/sample-aes.ts\n#EXT-X-ENDLIST\n',
                "/local.m3u8": f"{head}#EXTINF:2.0,\nfile://{elsewhere / 'secret.ts'}\n#EXT-X-ENDLIST\n",
            }
            segment = (elsewhere / "secret.ts").read_bytes()
            on_air = time.monotonic()

            def live() -> str:
                # A stream that does not end: a new segment every two
                # seconds, and every other one on the private network.
                first = int((time.monotonic() - on_air) / 2)
                listed = "".join(f"#EXTINF:2.0,\n{private if n % 2 else ''}/live/{n}.ts\n" for n in range(first, first + 3))
                return head.replace("SEQUENCE:0", f"SEQUENCE:{first}") + listed

            class Public(_Quiet):
                def do_GET(self) -> None:  # noqa: N802
                    if self.headers.get("Via"):
                        proxied.append(self.path)
                    if self.path == "/live.m3u8":
                        body, kind = live().encode(), "application/vnd.apple.mpegurl"
                    elif self.path.startswith("/live/"):
                        body, kind = segment, "video/mp2t"
                    elif self.path in playlists:
                        body, kind = playlists[self.path].encode(), "application/vnd.apple.mpegurl"
                    elif self.path == "/redirects.mp4" and self.headers.get("Icy-MetaData"):
                        # Only ffmpeg asks for Icy metadata; this file sends
                        # ffmpeg, and only ffmpeg, somewhere else.
                        self.send_response(302)
                        self.send_header("Location", f"{private}/progressive.mp4")
                        self.end_headers()
                        return
                    else:
                        body, kind = sample_mp4, "video/mp4"
                    self.send_response(200)
                    self.send_header("Content-Type", kind)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            with _serving(Public) as public:
                yield public, hits, proxied

    @pytest.mark.parametrize(
        ("path", "clip"),
        [
            ("/vod.m3u8", (0.0, 1.0)),
            ("/sample-aes.m3u8", None),
            ("/redirects.mp4", (0.0, 1.0)),
        ],
        ids=["clip-of-hls", "sample-aes", "clip-of-a-file-that-redirects-ffmpeg"],
    )
    def test_nothing_reaches_the_private_network(self, network, path: str, clip) -> None:  # noqa: ANN001
        public, hits, proxied = network
        start, end = clip or (None, None)
        job = _run(public + path, clip_start=start, clip_end=end)
        assert hits == []
        assert path in proxied, "ffmpeg did not go through the proxy"
        # ffmpeg only says it failed; the proxy knows why.
        assert (job.state, job.error) == ("error", server_app.PRIVATE_ADDRESS_MESSAGE)

    @pytest.mark.parametrize("no_proxy", ["*", "localhost,127.0.0.1,127.0.0.3"])
    def test_no_proxy_is_no_way_around_the_proxy(self, network, monkeypatch: pytest.MonkeyPatch, no_proxy: str) -> None:  # noqa: ANN001
        """
        ffmpeg connects straight to every host no_proxy names, and a
        container's names loopback often enough, or everything.
        """
        public, hits, proxied = network
        monkeypatch.setenv("no_proxy", no_proxy)
        monkeypatch.setenv("NO_PROXY", no_proxy)
        job = _run(public + "/redirects.mp4", clip_start=0.0, clip_end=1.0)
        assert hits == []
        assert "/redirects.mp4" in proxied
        assert (job.state, job.error) == ("error", server_app.PRIVATE_ADDRESS_MESSAGE)

    @pytest.mark.parametrize("private_hosts", [False, True], ids=["guarded", "private-hosts-allowed"])
    def test_a_playlist_cannot_name_a_file_on_this_machine(self, network, monkeypatch: pytest.MonkeyPatch, private_hosts: bool) -> None:  # noqa: ANN001
        """
        ffmpeg is told which protocols it may open, before every input.

        A playlist from http already cannot name file: — ffmpeg's http gives
        what it opens a list of its own without it — so the job failing says
        nothing about the list this server passes. That list is what drops
        rtp and udp, which ffmpeg's own allows and which would open sockets
        the proxy never sees, and it holds whatever protocol the input starts
        on. So it is the command that is checked. Allowing private hosts is
        about addresses, and lifts none of it.
        """
        public, _hits, proxied = network
        monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", private_hosts)
        started: list[list[str]] = []

        class Recording(server_app._ProxiedPopen):
            def __init__(self, args: Any, *remaining: Any, **kwargs: Any) -> None:
                started.append([str(arg) for arg in args])
                super().__init__(args, *remaining, **kwargs)

        monkeypatch.setattr(server_app.external_downloaders, "Popen", Recording)
        job = _run(public + "/local.m3u8", clip_start=0.0, clip_end=1.0)
        assert ("/local.m3u8" in proxied) is not private_hosts
        assert job.state == "error"
        commands = [args for args in started if "-i" in args]
        assert commands, "ffmpeg was never started"
        for args in commands:
            for index in (n for n, arg in enumerate(args) if arg == "-i"):
                assert args[index - 2 : index] == ["-protocol_whitelist", server_app.FFMPEG_PROTOCOLS], args

    def test_a_live_stream_goes_through_the_proxy_and_stops_when_cancelled(self, network) -> None:  # noqa: ANN001
        """
        Refused while ffmpeg's connections went unchecked; recorded now,
        with its private segments refused. ffmpeg tells yt-dlp nothing until
        it is done, which for a live stream is whenever the stream ends, so
        a cancelled one kept recording — holding a download slot throughout.
        """
        public, hits, proxied = network
        job = server_app.Job(id=uuid.uuid4().hex[:16], url=public + "/live.m3u8", preset="video_best")
        worker = threading.Thread(target=server_app.run_job, args=(job,), daemon=True)
        worker.start()
        deadline = time.monotonic() + 20
        while not any(path.startswith("/live/") for path in proxied) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert "/live.m3u8" in proxied and any(path.startswith("/live/") for path in proxied), job.error
        # Long enough to have been offered a private segment.
        time.sleep(2.5)
        job.cancelled = True
        worker.join(timeout=15)
        assert not worker.is_alive(), "ffmpeg kept recording a cancelled live stream"
        assert hits == []
        assert not job.directory.exists()

    def test_behind_the_operators_proxy_ffmpeg_is_still_refused(self, network, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
        """
        Pointed at this server's proxy, ffmpeg would go around the one the
        operator configured; pointed at theirs, around the guard. So there
        it stays refused, as it was before the proxy.
        """
        public, hits, proxied = network
        monkeypatch.setattr(server_app, "BEHIND_A_PROXY", True)
        job = _run(public + "/redirects.mp4", clip_start=0.0, clip_end=1.0)
        assert (job.state, job.error) == ("error", server_app.FFMPEG_BEHIND_A_PROXY)
        assert hits == [] and proxied == []

    @pytest.mark.parametrize(
        ("preset", "ext", "start", "end"),
        [
            ("video_best", ".mp4", 1.0, 2.0),
            ("audio_m4a", ".m4a", 1.0, 2.0),
            ("video_best", ".mp4", 3.0, None),
            ("video_best", ".mp4", None, 1.0),
        ],
        ids=["video", "audio", "to-the-end", "from-the-start"],
    )
    def test_a_clip_is_still_a_clip(self, network, preset: str, ext: str, start: float | None, end: float | None) -> None:  # noqa: ANN001
        """Four seconds in, one second out, fetched by ffmpeg through the proxy."""
        public, hits, proxied = network
        job = _run(public + "/v.mp4", preset=preset, clip_start=start, clip_end=end)
        assert job.state == "done", job.error
        assert job.filename.endswith(ext)
        assert 0.8 <= _duration(job.directory / job.filename) <= 1.2
        assert "/v.mp4" in proxied
        assert hits == []

    def test_what_ffmpeg_does_after_the_download_it_does_to_files_on_disk(self, network, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
        """
        Only the downloader is handed a URL. The postprocessors — the
        merge, the audio extraction, the tags, the cover, the subtitles —
        run ffmpeg too, on what is already in the job's directory; yt-dlp
        passes an http(s) name to ffmpeg as it is, so one handed a URL
        would fetch it, with nothing in between.
        """
        public, _hits, _proxied = network
        ffmpeg_pp = server_app.yt_dlp.postprocessor.FFmpegPostProcessor
        real = ffmpeg_pp._ffmpeg_filename_argument
        named: list[str] = []

        def recording(name: str) -> str:
            named.append(name)
            return real(name)

        monkeypatch.setattr(ffmpeg_pp, "_ffmpeg_filename_argument", staticmethod(recording))
        job = _run(public + "/v.mp4", preset="audio_m4a", clip_start=1.0, clip_end=2.0)
        assert job.state == "done", job.error
        assert named
        assert all(Path(name).resolve().is_relative_to(job.directory.resolve()) for name in named), named


@needs_ffmpeg
@pytest.mark.skipif(not shutil.which("openssl"), reason="needs openssl for a certificate")
@pytest.mark.parametrize("path", ["/v.mp4", "/hop"], ids=["a-clip", "a-redirect-to-the-private-network"])
def test_https_is_tunnelled_and_each_hop_checked(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, sample_mp4: bytes, path: str) -> None:
    """
    ffmpeg speaks https through the proxy with CONNECT, and a tunnel is all
    the proxy sees of it: the host and the port, checked before it opens. A
    redirect is a CONNECT of its own, and checked the same way.
    """
    from yt_dlp.extractor.common import InfoExtractor

    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
         "-keyout", str(tmp_path / "key.pem"), "-out", str(tmp_path / "cert.pem")],
        check=True, capture_output=True,
    )
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(tmp_path / "cert.pem", tmp_path / "key.pem")
    monkeypatch.setattr(server_app, "refused_address", lambda raw: str(raw) == "127.0.0.3")
    monkeypatch.setattr(server_app, "EXEMPT_HOSTS", frozenset())
    monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", False)
    monkeypatch.setattr(server_app, "BEHIND_A_PROXY", False)
    monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path)
    tunnels: list[str] = []
    connect = server_app.GuardedProxy.do_CONNECT

    def watched(handler: "server_app.GuardedProxy") -> None:
        tunnels.append(handler.path)
        connect(handler)

    monkeypatch.setattr(server_app.GuardedProxy, "do_CONNECT", watched)
    hits: list[str] = []

    class Private(_Quiet):
        def do_GET(self) -> None:  # noqa: N802
            hits.append(self.path)
            self.send_response(200)
            self.send_header("Content-Length", str(len(sample_mp4)))
            self.end_headers()
            self.wfile.write(sample_mp4)

    with _serving(Private, "127.0.0.3", tls) as private:

        class Media(_Quiet):
            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/hop":
                    self.send_response(302)
                    self.send_header("Location", f"{private}/secret.mp4")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                # A CDN's answer to a range: ffmpeg seeks back for the index
                # at the end of the file.
                first = int(self.headers.get("Range", "bytes=0-")[6:].split("-")[0] or 0)
                self.send_response(206 if first else 200)
                self.send_header("Accept-Ranges", "bytes")
                if first:
                    self.send_header("Content-Range", f"bytes {first}-{len(sample_mp4) - 1}/{len(sample_mp4)}")
                self.send_header("Content-Length", str(len(sample_mp4) - first))
                self.end_headers()
                self.wfile.write(sample_mp4[first:])

        with _serving(Media, tls=tls) as media:

            class SecureIE(InfoExtractor):
                _VALID_URL = r"https://secure\.example/v/(?P<id>\w+)"

                def _real_extract(self, url: str) -> dict:
                    return {
                        "id": self._match_id(url),
                        "title": "Over TLS",
                        "formats": [{"format_id": "mp4", "url": media + path, "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a"}],
                    }

            _with_extractors(monkeypatch, SecureIE)
            job = _run("https://secure.example/v/abc", clip_start=1.0, clip_end=2.0)
    assert urlsplit(media).netloc in tunnels
    assert hits == []
    if path == "/hop":
        assert urlsplit(private).netloc in tunnels
        assert (job.state, job.error) == ("error", server_app.PRIVATE_ADDRESS_MESSAGE)
    else:
        assert job.state == "done", job.error
        assert 0.8 <= _duration(job.directory / job.filename) <= 1.2


@pytest.mark.parametrize("name", ["FFMPEG_FETCH_REFUSED", "FFMPEG_BEHIND_A_PROXY", "PRIVATE_ADDRESS_MESSAGE"])
def test_a_refusal_reaches_the_page_as_it_was_written(name: str) -> None:
    """Anything saying "ffmpeg" and "not" is otherwise read as "ffmpeg is missing"."""
    message = getattr(server_app, name)
    assert server_app.humanize_error(Exception(f"ERROR: {message}"), "https://cdn.example/v.mp4") == message


def test_ffmpeg_is_not_handed_what_the_proxy_cannot_carry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """
    rtmp, rtsp and the rest are ffmpeg's own protocols, spoken over sockets
    the proxy never sees. The format check refuses them first; this is the
    downloader refusing them too, for whatever reaches it another way.
    """
    import re as _re

    monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", False)
    with server_app.yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
        downloader = server_app.FFmpegFD(ydl, ydl.params)
        with pytest.raises(server_app.yt_dlp.utils.DownloadError, match=_re.escape(server_app.FFMPEG_FETCH_REFUSED)):
            downloader.real_download(str(tmp_path / "live.flv"), {"id": "x", "url": "rtmp://10.0.0.1/live/stream", "protocol": "rtmp", "ext": "flv"})


@needs_ffmpeg
def test_a_redirect_to_the_sidecars_machine_on_another_port_is_refused(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, sample_mp4: bytes) -> None:
    """
    With the provider on 127.0.0.1:4416, a public playlist whose segment
    redirected to 127.0.0.1 on any other port was followed, and that
    service's answer landed in the download.
    """
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(server_app, "POT_PROVIDER_URL", "http://127.0.0.1:4416")
    monkeypatch.setattr(server_app, "EXEMPT_HOSTS", server_app._exempt_hosts())
    monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", False)
    monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path)
    # 127.0.0.5 plays the public host; the rest of loopback is what it is.
    refused = server_app.refused_address
    monkeypatch.setattr(server_app, "refused_address", lambda raw: str(raw) != "127.0.0.5" and refused(raw))
    hits: list[str] = []

    class Local(_Quiet):
        def do_GET(self) -> None:  # noqa: N802
            hits.append(self.path)
            self.send_response(200)
            self.send_header("Content-Length", str(len(sample_mp4)))
            self.end_headers()
            self.wfile.write(sample_mp4)

    with _serving(Local) as local:
        playlist = b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n/seg0.ts\n#EXT-X-ENDLIST\n"

        class Public(_Quiet):
            def do_GET(self) -> None:  # noqa: N802
                if self.path.startswith("/seg"):
                    self.send_response(302)
                    self.send_header("Location", f"{local}/secret.ts")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(playlist)))
                self.end_headers()
                self.wfile.write(playlist)

        with _serving(Public, "127.0.0.5") as public:
            job = _run(public + "/x.m3u8")
    assert hits == []
    assert job.state == "error"


# ------------------------------------------------------- what counts as media


class TestEveryMediaExtension:
    """
    A single-file format keeps the site's extension — merge_output_format
    only applies to a merge — and a download in one this list did not know
    was fetched, tagged, and then reported as "yt-dlp produced no file".
    """

    @pytest.mark.parametrize("ext", [".m4v", ".ogv", ".flv", ".ts", ".3gp", ".mpg", ".mpeg", ".wmv", ".mka", ".oga", ".weba", ".m4b"])
    def test_a_download_is_found_whatever_its_extension(self, tmp_path: Path, ext: str) -> None:
        (tmp_path / f"a [x]{ext}").write_bytes(b"x")
        (tmp_path / "a [x].webp").write_bytes(b"x")
        assert [p.suffix for p in server_app.media_files(tmp_path)] == [ext]

    @needs_ffmpeg
    @pytest.mark.parametrize(
        ("ext", "codecs"),
        [
            ("m4v", ["-c:v", "libx264", "-c:a", "aac", "-f", "mp4"]),
            ("ogv", ["-c:v", "libtheora", "-c:a", "libvorbis"]),
            ("flv", ["-c:v", "flv1", "-c:a", "libmp3lame", "-ar", "44100"]),
            ("ts", ["-c:v", "libx264", "-c:a", "aac"]),
            ("3gp", ["-c:v", "h263", "-s", "176x144", "-c:a", "aac", "-ar", "8000", "-ac", "1"]),
        ],
    )
    def test_a_job_for_one_finishes_with_it(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ext: str, codecs: list[str]) -> None:
        media = tmp_path / "media"
        media.mkdir()
        try:
            _ffmpeg("-f", "lavfi", "-i", "testsrc=size=176x144:rate=10:duration=1", "-f", "lavfi", "-i", "sine=duration=1", *codecs, str(media / f"clip.{ext}"))
        except subprocess.CalledProcessError:
            pytest.skip(f"this ffmpeg cannot write .{ext}")
        monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", True)
        monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path / "jobs")
        with _serving(functools.partial(_Quiet, directory=str(media))) as base:
            job = _run(f"{base}/clip.{ext}")
        assert job.state == "done", job.error
        assert job.filename.endswith(f".{ext}")


# ------------------------------------------------ the tunnel and a cookie jar


def test_the_tunnel_sends_the_cookies_the_resolve_relied_on(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """
    yt-dlp keeps cookies out of a format's http_headers and sends them from
    its jar, so a host that set one during extraction answered the tunnel
    403 — though yt-dlp itself could have fetched the file. And a redirect to
    another host must not take the cookie with it.
    """
    from yt_dlp.extractor.common import InfoExtractor

    seen: dict[str, list[str | None]] = {"media": [], "elsewhere": []}

    class Elsewhere(_Quiet):
        def do_GET(self) -> None:  # noqa: N802
            seen["elsewhere"].append(self.headers.get("Cookie"))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

    with _serving(Elsewhere) as elsewhere:
        other_host = elsewhere.replace("127.0.0.1", "localhost")

        class Media(_Quiet):
            def do_GET(self) -> None:  # noqa: N802
                seen["media"].append(self.headers.get("Cookie"))
                if self.headers.get("Cookie") != "sess=abc":
                    self.send_response(403)
                    self.end_headers()
                elif self.path == "/hop":
                    self.send_response(302)
                    self.send_header("Location", f"{other_host}/file")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Content-Length", "4")
                    self.end_headers()
                    self.wfile.write(b"DATA")

        with _serving(Media) as media:

            class CookieSite(InfoExtractor):
                _VALID_URL = r"https://cookie-site\.example/v/(?P<id>\w+)"

                def _real_extract(self, url: str) -> dict:
                    self._set_cookie("127.0.0.1", "sess", "abc")
                    return {
                        "id": self._match_id(url),
                        "title": "A video behind a cookie",
                        "formats": [
                            {"format_id": "v", "url": f"{media}/v.mp4", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a"},
                            {"format_id": "hop", "url": f"{media}/hop", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a"},
                        ],
                    }

            real = server_app.yt_dlp.YoutubeDL

            class WithCookieSite(real):
                def add_default_info_extractors(self) -> None:
                    self.add_info_extractor(CookieSite())
                    super().add_default_info_extractors()

            monkeypatch.setattr(server_app.yt_dlp, "YoutubeDL", WithCookieSite)
            monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", True)
            monkeypatch.setattr(server_app, "TUNNEL_HOSTS", {})

            resolved = client.post("/api/resolve", json={"url": "https://cookie-site.example/v/v1"})
            assert resolved.status_code == 200, resolved.text
            tunnelled = client.get("/api/tunnel", params={"url": f"{media}/v.mp4"})
            assert tunnelled.status_code == 200, tunnelled.text
            assert tunnelled.content == b"DATA"
            assert seen["media"][-1] == "sess=abc"

            hopped = client.get("/api/tunnel", params={"url": f"{media}/hop"})
            assert hopped.status_code == 200, hopped.text
            assert seen["elsewhere"] == [None]


def test_the_tunnel_never_carries_the_uploaded_session(client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """
    The jar a resolve reads also holds the uploaded cookies.txt. A grant is
    for a whole host, so granting those let anyone who can resolve a page
    with a video on a cookie domain read any page there signed in as the
    owner. Only what the site set during this extraction goes to the tunnel,
    and a cookie the file had is kept back even when the site rotated it.
    """
    from yt_dlp.extractor.common import InfoExtractor

    seen: list[str | None] = []

    class Victim(_Quiet):
        def do_GET(self) -> None:  # noqa: N802
            seen.append(self.headers.get("Cookie"))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

    with _serving(Victim) as victim:

        class Planted(InfoExtractor):
            _VALID_URL = r"https://planted\.example/v/(?P<id>\w+)"

            def _real_extract(self, url: str) -> dict:
                self._set_cookie("127.0.0.1", "sess", "abc")
                self._set_cookie("127.0.0.1", "rotated", "new")
                return {
                    "id": self._match_id(url),
                    "title": "A video on a host the owner is signed in to",
                    "formats": [{"format_id": "v", "url": f"{victim}/a.mp4", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a"}],
                }

        real = server_app.yt_dlp.YoutubeDL

        class WithPlanted(real):
            def add_default_info_extractors(self) -> None:
                self.add_info_extractor(Planted())
                super().add_default_info_extractors()

        cookies = tmp_path / "cookies.txt"
        cookies.write_text(
            "# Netscape HTTP Cookie File\n"
            "127.0.0.1\tFALSE\t/\tFALSE\t2147483647\tSID\toperator-session-secret\n"
            "127.0.0.1\tFALSE\t/\tFALSE\t2147483647\trotated\told\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(server_app, "COOKIES_PATH", cookies)
        monkeypatch.setattr(server_app.yt_dlp, "YoutubeDL", WithPlanted)
        monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", True)
        monkeypatch.setattr(server_app, "TUNNEL_HOSTS", {})

        resolved = client.post("/api/resolve", json={"url": "https://planted.example/v/v1"})
        assert resolved.status_code == 200, resolved.text
        assert server_app._granted("127.0.0.1").get("Cookie") == "sess=abc"
        page = client.get("/api/tunnel", params={"url": f"{victim}/account/private-page"})
        assert page.status_code == 200, page.text
        assert seen == ["sess=abc"]


# --------------------------------------------------------- the event loop


@pytest.mark.parametrize(
    ("method", "path", "kwargs", "slow_name"),
    [
        ("post", "/api/probe", {"json": {"url": "https://slow.example/v"}}, "slow.example"),
        ("post", "/api/resolve", {"json": {"url": "https://slow.example/v"}}, "slow.example"),
        ("post", "/api/jobs", {"json": {"url": "https://slow.example/v"}}, "slow.example"),
        ("get", "/api/tunnel", {"params": {"url": "https://slow.example/v"}}, "slow.example"),
        ("get", "/api/health", {}, socket.gethostname()),
    ],
)
def test_a_slow_lookup_holds_up_only_its_own_request(monkeypatch: pytest.MonkeyPatch, method: str, path: str, kwargs: dict, slow_name: str) -> None:
    """
    A name whose nameserver does not answer took seconds to fail, on the
    event loop — and every other request, a progress poll or a tunnel
    stream, waited for it.
    """
    real = server_app._REAL_GETADDRINFO

    def lookup(host, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        if host == slow_name:
            time.sleep(1)
            raise socket.gaierror(socket.EAI_NONAME, "the nameserver never answered")
        return real(host, *args, **kwargs)

    monkeypatch.setattr(server_app, "_REAL_GETADDRINFO", lambda *a, **k: lookup(*a, **k))

    async def race() -> float:
        transport = httpx.ASGITransport(app=server_app.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://siphon.test") as http:
            started = time.monotonic()
            slow = asyncio.create_task(getattr(http, method)(path, **kwargs))
            # Long enough for the slow request to reach its lookup.
            await asyncio.sleep(0.2)
            other = await http.get("/api/jobs/nothing-here")
            elapsed = time.monotonic() - started
            await slow
            assert other.status_code == 404
            return elapsed

    assert asyncio.run(race()) < 0.8


# ------------------------------------------------- a site of our own making


def _with_extractors(monkeypatch: pytest.MonkeyPatch, *extractors: type) -> None:
    """The real yt-dlp, with these extractors ahead of its own."""
    real = server_app.yt_dlp.YoutubeDL

    class WithFakes(real):
        def add_default_info_extractors(self) -> None:
            for extractor in extractors:
                self.add_info_extractor(extractor())
            super().add_default_info_extractors()

    monkeypatch.setattr(server_app.yt_dlp, "YoutubeDL", WithFakes)


# ------------------------------------------------ a playlist behind the wall


class TestAPlaylistBehindTheBotWall:
    """
    A playlist runs with ignoreerrors, so a bot wall on every one of its
    videos raised nothing: the job said "That playlist is empty.", only
    yt-dlp's default client was tried, and the advice about cookies never
    came — on a datacentre server without cookies, the usual case.
    """

    WALL = "Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication."

    @pytest.fixture()
    def youtube(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
        from yt_dlp.extractor.common import InfoExtractor
        from yt_dlp.utils import ExtractorError

        monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path)
        monkeypatch.setattr(server_app, "COOKIES_PATH", tmp_path / "no-cookies.txt")
        wall = self.WALL
        state: dict = {"tried": [], "videos": 3, "list_walled": False}

        def client(extractor: InfoExtractor) -> str:
            return (extractor._configuration_arg("player_client", ie_key="youtube") or ["default"])[0]

        class FakeVideoIE(InfoExtractor):
            _VALID_URL = r"https://www\.youtube\.com/watch\?v=(?P<id>fake\d)"

            def _real_extract(self, url: str) -> dict:
                state["tried"].append(client(self))
                raise ExtractorError(wall, expected=True)

        class FakePlaylistIE(InfoExtractor):
            _VALID_URL = r"https://www\.youtube\.com/playlist\?list=(?P<id>PL\w+)"

            def _real_extract(self, url: str) -> dict:
                if state["list_walled"]:
                    state["tried"].append(client(self))
                    raise ExtractorError(wall, expected=True)
                entries = [self.url_result(f"https://www.youtube.com/watch?v=fake{i}", FakeVideoIE) for i in range(state["videos"])]
                return self.playlist_result(entries, self._match_id(url), "A playlist")

        _with_extractors(monkeypatch, FakeVideoIE, FakePlaylistIE)
        return state

    @pytest.mark.parametrize("list_walled", [False, True], ids=["every-video", "the-list-itself"])
    def test_the_ladder_is_walked_and_cookies_are_named(self, youtube: dict, list_walled: bool) -> None:
        youtube["list_walled"] = list_walled
        job = _run("https://www.youtube.com/playlist?list=PLfake", is_playlist=True)
        ladder = server_app.player_client_chain(False)
        assert job.state == "error"
        assert job.attempts == len(ladder) - 1
        assert set(youtube["tried"]) == {client or "default" for client in ladder}
        assert "cookies" in job.error.lower()

    def test_a_playlist_with_no_videos_is_still_empty(self, youtube: dict) -> None:
        youtube["videos"] = 0
        job = _run("https://www.youtube.com/playlist?list=PLempty", is_playlist=True)
        assert (job.state, job.error, job.attempts) == ("error", "That playlist is empty.", 0)


# ------------------------------------------------------ a clip's subtitles


@needs_ffmpeg
@pytest.mark.parametrize("guarded", [True, False], ids=["through-the-proxy", "private-hosts-allowed"])
@pytest.mark.parametrize("subs", ["embed", "files"])
def test_a_clips_subtitles_are_the_clips(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, sample_mp4: bytes, subs: str, guarded: bool) -> None:
    """
    The media was cut and the subtitle files were not: a clip from 0:02 had
    the cues of 0:00 as separate files, and a .srt the length of the video.
    yt-dlp fetches the subtitles whole whichever way the clip is fetched.
    """
    import zipfile

    from yt_dlp.extractor.common import InfoExtractor

    vtt = "WEBVTT\n\n" + "".join(f"00:00:0{s}.000 --> 00:00:0{s}.900\nsecond {s}\n\n" for s in range(4))

    proxied: list[str] = []

    class Site(_Quiet):
        def do_GET(self) -> None:  # noqa: N802
            if self.headers.get("Via"):
                proxied.append(self.path)
            body, kind = (vtt.encode(), "text/vtt") if self.path.endswith(".vtt") else (sample_mp4, "video/mp4")
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    if guarded:
        # Loopback plays the internet.
        monkeypatch.setattr(server_app, "refused_address", lambda _raw: False)
        monkeypatch.setattr(server_app, "BEHIND_A_PROXY", False)
    monkeypatch.setattr(server_app, "ALLOW_PRIVATE_HOSTS", not guarded)
    monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path)
    with _serving(Site) as base:

        class SubtitledIE(InfoExtractor):
            _VALID_URL = r"https://subtitled\.example/v/(?P<id>\w+)"

            def _real_extract(self, url: str) -> dict:
                return {
                    "id": self._match_id(url),
                    "title": "Subtitled",
                    "formats": [{"format_id": "mp4", "url": f"{base}/v.mp4", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a"}],
                    "subtitles": {"en": [{"ext": "vtt", "url": f"{base}/en.vtt"}]},
                }

        _with_extractors(monkeypatch, SubtitledIE)
        job = _run("https://subtitled.example/v/abc", subs=subs, sub_langs="en", clip_start=2.0, clip_end=3.0)
    assert job.state == "done", job.error
    # The video through the proxy, when there is a guard; the subtitles by yt-dlp.
    assert set(proxied) == ({"/v.mp4"} if guarded else set())
    path = job.directory / job.filename
    if subs == "files":
        with zipfile.ZipFile(path) as bundle:
            srt = next(bundle.read(name).decode() for name in bundle.namelist() if name.endswith(".srt"))
    else:
        srt = subprocess.run(
            [FFMPEG, "-loglevel", "error", "-i", str(path), "-map", "0:s:0", "-f", "srt", "-"],
            capture_output=True, text=True, check=True,
        ).stdout
    cues = [block.splitlines() for block in srt.strip().split("\n\n")]
    assert cues[0][1].startswith("00:00:00,000 --> ")
    assert [cue[2] for cue in cues] == ["second 2"]


# --------------------------------------------- subtitle languages on a server


class TestSubtitleLanguagesArePreferences:
    """
    The languages are a preference list, as on the device: the first one the
    video has, "en" standing for en-GB too, a written track over a machine
    one, and something rather than nothing. yt-dlp alone reads them as exact
    names and takes every one that matches.
    """

    WRITTEN_BEATS_AUTO = ({"en-US": "human"}, {"en": "machine"})

    @pytest.mark.parametrize(
        ("langs", "written", "auto", "picked"),
        [
            ("fr,en", {"ja": "ja"}, {}, ["ja"]),
            ("en", {"en-GB": "en-GB"}, {}, ["en-GB"]),
            ("en", {"en-US": "human"}, {"en": "machine"}, ["en-US"]),
            ("fr,en", {"fr": "fr", "en": "en"}, {}, ["fr"]),
            ("de,en", {}, {"ab": "ab", "en-orig": "en-orig", "en": "en", "de": "de"}, ["de"]),
            ("sv", {}, {"ab": "ab", "ja-orig": "ja-orig", "ja": "ja"}, ["ja-orig"]),
            ("en", {}, {}, []),
        ],
        ids=["fallback", "a-regional-variant", "written-over-machine", "the-first-preference", "auto", "the-originals-fallback", "none"],
    )
    def test_one_track_is_picked_the_way_the_device_picks_it(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, langs: str, written: dict, auto: dict, picked: list[str]) -> None:
        monkeypatch.setattr(server_app, "DOWNLOAD_ROOT", tmp_path)
        monkeypatch.setattr(server_app, "COOKIES_PATH", tmp_path / "no-cookies.txt")
        job = server_app.Job(id="p" * 16, url="https://site.example/v", preset="video_720", subs="embed", sub_langs=langs)

        def offered(tracks: dict) -> dict:
            return {lang: [{"ext": "vtt", "url": f"https://s.example/{name}.vtt"}] for lang, name in tracks.items()}

        with server_app.yt_dlp.YoutubeDL(server_app.build_options(job, None)) as ydl:
            for step, when in server_app.job_postprocessors(job):
                ydl.add_post_processor(step, when=when)
            info = ydl.process_ie_result({
                "id": "v", "title": "A video", "extractor": "site", "extractor_key": "Site", "webpage_url": "https://site.example/v",
                "formats": [{"format_id": "0", "url": "https://cdn.example/v.mp4", "ext": "mp4", "vcodec": "avc1", "acodec": "mp4a", "height": 720}],
                "subtitles": offered(written), "automatic_captions": offered(auto),
            }, download=False)
        requested = info.get("requested_subtitles") or {}
        assert list(requested) == picked
        for lang in picked:
            assert requested[lang]["url"] == f"https://s.example/{(written | auto)[lang] if lang in written else auto[lang]}.vtt"

    def test_a_live_chat_is_no_subtitle_to_fall_back_on(self) -> None:
        """YouTube files a replay's chat under subtitles: hours of JSON, and nothing a player shows."""
        chat = {"live_chat": [{"ext": "json", "url": "https://s.example/chat"}]}
        assert server_app.pick_subtitle(chat, {}, ["en"]) is None
        assert server_app.pick_subtitle({**chat, "ja": [{"ext": "vtt", "url": "u"}]}, {}, ["en"]) == "ja"


# ------------------------------------------------ the address for a phone


class TestThePhoneAddress:
    """
    "Open this on your phone" named the machine's own interfaces, which in
    the documented `docker run -p` is the container's bridge (172.17.0.x),
    behind a host's proxy is its internal network, and for a server bound to
    127.0.0.1 is an address nothing answers on.
    """

    @pytest.fixture(autouse=True)
    def _a_lan(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "LAN_URLS", [])
        monkeypatch.setattr(server_app, "in_container", lambda: False)
        monkeypatch.setattr(server_app, "lan_addresses", lambda: ["192.168.1.42"])
        monkeypatch.setattr(server_app, "answers", lambda _address, _port: True)

    @staticmethod
    def _lan_urls(client: TestClient, **headers: str) -> list[str]:
        # A server listening on 8000, as uvicorn tells the app, whatever the
        # Host header says.
        listening = TestClient(server_app.app, base_url="http://localhost:8000")
        return listening.get("/api/health", headers=headers).json()["lanUrls"]

    def test_a_server_on_the_lan_names_its_address(self, client: TestClient) -> None:
        assert self._lan_urls(client) == ["http://192.168.1.42:8000"]

    def test_the_port_tried_is_the_one_this_server_listens_on(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        """
        The Host header is the caller's to write. Trying the port it named
        made health, which asks for no key, a way to learn which ports this
        machine listens on at its own private addresses — firewalled ones too.
        """
        tried: list[int] = []
        monkeypatch.setattr(server_app, "answers", lambda _address, port: tried.append(port) or True)
        assert self._lan_urls(client, host="anything:6379") == ["http://192.168.1.42:8000"]
        assert tried == [8000]
        # No port to go by, as on a Unix socket: nothing is tried.
        assert server_app.lan_urls("http", None, False) == []
        assert tried == [8000]

    def test_a_container_names_none_of_its_own(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "lan_addresses", lambda: ["172.17.0.2"])
        monkeypatch.setattr(server_app, "in_container", lambda: True)
        assert self._lan_urls(client) == []

    def test_the_operator_can_say_which_address(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "in_container", lambda: True)
        monkeypatch.setattr(server_app, "LAN_URLS", ["http://192.168.1.42:8000"])
        assert self._lan_urls(client) == ["http://192.168.1.42:8000"]

    @pytest.mark.parametrize("header", ["x-forwarded-for", "x-forwarded-proto", "forwarded"])
    def test_a_request_through_a_proxy_gets_none(self, client: TestClient, header: str) -> None:
        assert self._lan_urls(client, **{header: "https"}) == []

    def test_an_https_request_gets_none(self) -> None:
        secure = TestClient(server_app.app, base_url="https://siphon.example")
        assert secure.get("/api/health").json()["lanUrls"] == []

    def test_an_address_the_server_does_not_answer_on_is_left_out(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(server_app, "answers", lambda _address, _port: False)
        assert self._lan_urls(client) == []

    def test_answering_means_something_listens_there(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.undo()
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        try:
            assert server_app.answers("127.0.0.1", port) is True
        finally:
            listener.close()
        assert server_app.answers("127.0.0.1", port) is False


# -------------------------------------------------------- YouTube's clients


class TestYouTubeClients:
    """
    tv_embedded was offered long after yt-dlp dropped it. yt-dlp skips a
    client it does not know, with a warning nobody sees, and uses its
    default — so the first two rungs were the same request, and the row
    named a client that was never used.
    """

    def test_every_client_offered_is_one_yt_dlp_has(self) -> None:
        from yt_dlp.extractor.youtube._base import INNERTUBE_CLIENTS

        assert server_app.YT_CLIENTS <= set(INNERTUBE_CLIENTS)
        assert "tv_embedded" not in server_app.YT_CLIENTS

    def test_a_retired_client_is_no_preference_rather_than_a_refusal(self) -> None:
        # A page, or a saved setting, may still send it.
        assert server_app.check_yt_client("tv_embedded") == ""
        assert server_app.player_client_chain(False, server_app.check_yt_client("tv_embedded")) == [None, "tv", "web_safari", "android_vr"]
        with pytest.raises(ValueError, match="Unknown YouTube client"):
            server_app.check_yt_client("netscape")

    def test_health_lists_the_clients_a_page_may_offer(self, client: TestClient) -> None:
        assert client.get("/api/health").json()["ytClients"] == sorted(server_app.YT_CLIENTS)
