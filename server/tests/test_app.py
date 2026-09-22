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

import importlib
import sys
from pathlib import Path

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


class _FakeYdl:
    """Stands in for yt_dlp.YoutubeDL: returns a canned info dict."""

    info: dict = {}
    seen_options: list[dict] = []

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

    def test_tunnel_passes_an_upstream_refusal_through(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        client.post("/api/resolve", json={"url": "https://site.example/watch?v=abc"})
        monkeypatch.setattr(server_app, "urlopen", lambda *_a, **_k: _FakeUpstream(403, {}, []))
        response = client.get("/api/tunnel", params={"url": "https://cdn.example/v.webm"})
        assert response.status_code == 403
        assert "cdn.example answered 403" in response.json()["detail"]

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

    def test_a_hundred_auto_languages_are_capped(self) -> None:
        many = {f"l{i}": [{"ext": "vtt", "url": f"https://s.example/{i}.vtt"}] for i in range(100)}
        assert len(server_app.subtitle_tracks({"automatic_captions": many})) == server_app.SUBTITLE_LIMIT

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

    @pytest.mark.parametrize("text", ["abc", "1:99", "1:60:00", "1:2:3:4", "-5", "1h"])
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

    def test_a_clip_fetches_only_its_span_and_cuts_on_keyframes(self) -> None:
        options = server_app.build_options(self._job(clip_start=83.0, clip_end=100.0), None)
        assert options["force_keyframes_at_cuts"] is True
        spans = list(options["download_ranges"]({"id": "abc", "duration": 300}, None))
        assert spans == [{"start_time": 83.0, "end_time": 100.0}]
        # An open end runs to the end of the video.
        open_end = server_app.build_options(self._job(clip_start=83.0), None)
        assert list(open_end["download_ranges"]({"id": "abc"}, None))[0]["end_time"] == float("inf")
        assert "download_ranges" not in server_app.build_options(self._job(), None)

    def test_a_speed_limit_is_handed_to_yt_dlp_in_bytes(self) -> None:
        assert server_app.build_options(self._job(rate_limit=512000), None)["ratelimit"] == 512000
        assert "ratelimit" not in server_app.build_options(self._job(), None)

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
        monkeypatch.setattr(server_app.threading, "Thread", lambda *a, **k: type("T", (), {"start": lambda self: None})())
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
        monkeypatch.setattr(server_app.threading, "Thread", lambda *a, **k: type("T", (), {"start": lambda self: None})())
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
        monkeypatch.setattr(server_app, "EXEMPT_HOSTS", frozenset({"potoken"}))
        assert server_app.socket.getaddrinfo("potoken", 4416)
        with pytest.raises(server_app.PrivateAddress):
            server_app.socket.getaddrinfo("elsewhere", 4416)

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
        """A clip is fetched by ffmpeg, which never meets the socket guard."""
        with pytest.raises(server_app.yt_dlp.utils.DownloadError):
            server_app.CheckMediaUrls().run({"requested_formats": [{"url": "http://169.254.169.254/latest/meta-data/"}]})


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
