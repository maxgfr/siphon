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
