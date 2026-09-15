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
        calls = {"n": 0}

        def extract_info(self: _FakeYdl, _url: str, download: bool = True) -> dict:
            calls["n"] += 1
            if calls["n"] == 1:
                raise server_app.yt_dlp.utils.DownloadError("Sign in to confirm you're not a bot")
            return dict(_FakeYdl.info)

        monkeypatch.setattr(_FakeYdl, "extract_info", extract_info)
        response = client.post("/api/resolve", json={"url": "https://site.example/watch?v=abc"})
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
