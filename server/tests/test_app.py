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
