"""
What the README and the deploy files tell a person to type, checked against
the files it runs on.

Each of these once sent a reader somewhere that did not work: a log command
for a service the default compose file does not define, an update that
quietly dropped the provider overlay, a Fly access key generated straight
into a secret nobody could read back, a Render deploy whose uploaded cookies
vanished at the first sleep with nothing saying so, a phone promised a share
sheet over plain http, and test counts in docs/verified.md that no run had
produced. Commands are run where they can be, against stubs; where the check
can only be a reading of the prose, it says exactly what it reads.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tomllib
from pathlib import Path
from typing import Iterator

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def readme() -> str:
    return (ROOT / "README.md").read_text()


def paragraphs(text: str) -> list[str]:
    """Blank-line paragraphs, with each list item its own paragraph."""
    return [p for p in re.split(r"\n\s*\n|\n(?=- )", text) if p.strip()]


def sentences(paragraph: str) -> list[str]:
    return re.split(r"(?<=[.!?])\s+", " ".join(paragraph.split()))


def shell_blocks(text: str) -> list[str]:
    return re.findall(r"```sh\n(.*?)```", text, re.S)


def compose_commands() -> Iterator[tuple[str, str, list[str], str, list[str]]]:
    """
    Every `docker compose …` command in the docs and in the compose files'
    own comments: where it is, the line, the files it reads, the subcommand
    and its arguments. The arguments stop at a pipe, an `&&`, a backtick or a
    run of spaces, which in a comment is where the prose after it begins.
    """
    sources = [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md")), *sorted(ROOT.glob("docker-compose*.yml"))]
    for path in sources:
        for line in path.read_text().splitlines():
            for match in re.finditer(r"docker compose((?:\s+-f\s+\S+)*)\s+(\w+)((?:[ \t][^\s|&`]+)*)", line):
                files = re.findall(r"-f\s+(\S+)", match.group(1)) or ["docker-compose.yml"]
                yield path.name, line.strip(), files, match.group(2), match.group(3).split()


def services(files: list[str]) -> set[str]:
    defined: set[str] = set()
    for name in files:
        defined |= set(yaml.safe_load((ROOT / name).read_text())["services"])
    return defined


def test_every_compose_command_names_files_and_services_that_exist() -> None:
    # Compose validates a service name against the files it read before it
    # contacts the daemon, so `docker compose logs cloudflared` without the
    # tunnel overlay said "no such service" even with the tunnel running.
    checked = []
    for source, line, files, command, args in compose_commands():
        missing = [name for name in files if not (ROOT / name).is_file()]
        assert not missing, f"{source}: {line!r} reads {missing}, which do not exist"
        if command in {"logs", "ps", "pull", "restart", "start", "stop", "up"}:
            named = [arg for arg in args if not arg.startswith("-")]
            unknown = set(named) - services(files)
            assert not unknown, f"{source}: {line!r} names {sorted(unknown)}, which {files} do not define"
            checked.append((command, tuple(named)))
    assert ("logs", ("cloudflared",)) in checked, "the tunnel's URL is no longer read from its log"


def test_the_update_command_says_how_to_keep_the_overlays() -> None:
    # Compose recreates a service whose configuration changed. An update run
    # with fewer files than the start brings siphon back without what the
    # overlays gave it — the provider's address — with nothing but a warning
    # about an orphan container. Wherever the docs give the bare update, the
    # same paragraph says how to keep them.
    bare = [p for p in paragraphs(readme()) if "docker compose pull" in p]
    assert bare, "the README no longer gives the update command"
    for paragraph in bare:
        assert "COMPOSE_FILE" in paragraph, paragraph


def compose_file_values() -> list[str]:
    values = re.findall(r"COMPOSE_FILE=([\w.:-]+)", readme())
    assert values, "the README no longer says how to make every compose command read the overlays"
    return values


def test_the_documented_compose_file_starts_from_the_base_file() -> None:
    for value in compose_file_values():
        files = value.split(":")
        assert files[0] == "docker-compose.yml", value
        assert len(files) > 1 and all((ROOT / name).is_file() for name in files), value


def test_compose_file_in_dot_env_makes_the_bare_update_keep_the_provider(tmp_path: Path) -> None:
    docker = shutil.which("docker")
    if docker is None or subprocess.run([docker, "compose", "version"], capture_output=True).returncode != 0:
        pytest.skip("docker compose is not installed here")
    for path in ROOT.glob("docker-compose*.yml"):
        shutil.copy(path, tmp_path / path.name)
    for value in compose_file_values():
        (tmp_path / ".env").write_text(f"COMPOSE_FILE={value}\n")
        # `config` resolves the project exactly as `pull` and `up` would, and
        # needs no daemon. The environment's own COMPOSE_FILE would win over
        # the file's, so it is left out.
        env = {k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")}
        run = subprocess.run([docker, "compose", "config"], cwd=tmp_path, env=env, capture_output=True, text=True)
        assert run.returncode == 0, run.stderr
        if "docker-compose.potoken.yml" in value:
            assert "POT_PROVIDER_URL: http://potoken:4416" in run.stdout, run.stdout


def run_with_stub_fly(script: str, tmp_path: Path) -> tuple[str, str]:
    """Run the commands with a `fly` that only records what it was asked."""
    if shutil.which("bash") is None or shutil.which("openssl") is None:
        pytest.skip("needs bash and openssl")
    stub = tmp_path / "fly"
    stub.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FLY_LOG"\n')
    stub.chmod(0o755)
    log = tmp_path / "fly.log"
    env = {**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}", "FLY_LOG": str(log)}
    run = subprocess.run(["bash", "-e", "-c", script], env=env, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr
    return run.stdout, log.read_text()


def assert_key_shown(stdout: str, calls: str) -> None:
    secret = re.search(r"^secrets set AUTH_TOKEN=(\S+)$", calls, re.M)
    assert secret, calls
    assert re.fullmatch(r"[0-9a-f]{32}", secret.group(1)), secret.group(1)
    # Fly shows a secret's digest, never its value, once it is set; the app
    # asks for the value. So the one chance to see it is the terminal.
    assert secret.group(1) in stdout, f"the key Fly was given is printed nowhere: {stdout!r}"


def test_the_readme_fly_steps_print_the_key_they_set(tmp_path: Path) -> None:
    block = next(b for b in shell_blocks(readme()) if "fly secrets set" in b)
    assert_key_shown(*run_with_stub_fly(block, tmp_path))


def test_the_fly_toml_steps_print_the_key_they_set(tmp_path: Path) -> None:
    text = (ROOT / "fly.toml").read_text()
    header = text.split("\n\n", 1)[0]
    commands = "\n".join(line[4:] for line in header.splitlines() if line.startswith("#   "))
    assert "fly secrets set" in commands, header
    assert_key_shown(*run_with_stub_fly(commands, tmp_path))


def dockerfile_env(name: str) -> str:
    match = re.search(rf"\b{name}=(\S+)", (ROOT / "server" / "Dockerfile").read_text())
    assert match, name
    return match.group(1)


def under(path: str, directory: str) -> bool:
    return path.startswith(directory.rstrip("/") + "/")


def test_fly_keeps_the_cookie_jar_and_the_files_on_its_volume() -> None:
    fly = tomllib.loads((ROOT / "fly.toml").read_text())
    mounts = [mount["destination"] for mount in fly["mounts"]]
    for name in ("COOKIES_FILE", "DOWNLOAD_DIR"):
        value = fly["env"][name]
        assert any(value == d or under(value, d) for d in mounts), f"{name}={value} is not on {mounts}"


def test_render_says_whether_the_cookie_jar_survives_a_sleep() -> None:
    (service,) = yaml.safe_load((ROOT / "render.yaml").read_text())["services"]
    env = {var["key"]: var.get("value") for var in service.get("envVars", [])}
    jar = env.get("COOKIES_FILE") or dockerfile_env("COOKIES_FILE")
    if service.get("disk"):
        assert under(jar, service["disk"]["mountPath"]), f"COOKIES_FILE={jar} is not on the disk"
        return
    # No disk, which the free plan cannot have: the jar is on a filesystem
    # Render throws away at every spin-down, so the upload lasts until the
    # first sleep. The paragraph with the button has to say so.
    (paragraph,) = [p for p in paragraphs(readme()) if "render.yaml" in p and "AUTH_TOKEN" in p]
    assert any(
        "cookie" in s.lower() and "sleep" in s.lower() for s in sentences(paragraph)
    ), paragraph


def test_a_plain_http_lan_address_is_not_promised_the_share_sheet() -> None:
    # A plain-http address other than localhost is not a secure context: no
    # service worker, no install, so no share target — measured in Chromium,
    # which reports "not-from-secure-origin" for it. Where the README gives
    # such an address, a mention of the share sheet says it needs HTTPS.
    lan = re.compile(r"http://(192\.168|10|172\.(1[6-9]|2\d|3[01]))\.\d")
    share = re.compile(r"share (target|sheet)", re.I)
    found = False
    for paragraph in paragraphs(readme()):
        if not lan.search(paragraph):
            continue
        found = True
        said = [s for s in sentences(paragraph) if share.search(s)]
        if said:
            assert any("HTTPS" in s for s in said), said
    assert found, "the README no longer gives a LAN address to test against"


def suite_counts(lines: list[tuple[str, str]]) -> dict[str, int]:
    counts = {}
    for suite, text in lines:
        match = re.search(r"(?:^|— )(\d+)\b", text.strip())
        if match:
            counts[suite] = int(match.group(1))
    return counts


def test_verified_md_gives_no_test_count_the_readme_contradicts() -> None:
    # verified.md once carried a table of counts from an old run while the
    # README carried newer ones. The counts now live in the README's
    # Development block alone; a count verified.md gives again has to agree.
    block = readme().split("## Development", 1)[1].split("```sh\n", 1)[1].split("```", 1)[0]
    readme_counts = suite_counts(
        re.findall(r"^((?:pytest server/tests|npm test|npm run test:\w+))\b[^#\n]*#(.*)$", block, re.M)
    )
    assert readme_counts.get("pytest server/tests"), block
    verified = (ROOT / "docs" / "verified.md").read_text()
    verified_counts = {
        suite: int(count) for suite, count in re.findall(r"^\| `([^`]+)` \|.*\| (\d+) pass \|$", verified, re.M)
    }
    for suite, count in verified_counts.items():
        assert readme_counts.get(suite) == count, f"{suite}: verified.md says {count}, the README {readme_counts.get(suite)}"


def test_allowed_origins_is_given_an_origin_not_a_page_address() -> None:
    # A browser's Origin has no path. "Set ALLOWED_ORIGINS to your page's URL"
    # put https://you.github.io/siphon/ there, which the relay and the server
    # both compared as written, so the owner's own page was the one refused.
    # Both now cut an address down to its origin; the docs still ask for one.
    said = []
    for path in (ROOT / "README.md", ROOT / "relay" / "README.md"):
        for paragraph in paragraphs(path.read_text()):
            said += [(path.name, s) for s in sentences(paragraph) if "ALLOWED_ORIGINS" in s]
    assert said, "the docs no longer say how to set ALLOWED_ORIGINS"
    for name, sentence in said:
        assert not re.search(r"\bURL\b", sentence), f"{name}: {sentence}"


def test_a_worker_set_up_by_the_button_keeps_its_origin_lock() -> None:
    # The Deploy button sets up a build that runs `wrangler deploy` on every
    # push, and without keep_vars a deploy deletes the plain-text variables
    # the file does not list. ALLOWED_ORIGINS set in the dashboard went that
    # way, and a relay with no origin list answers every site, silently. A
    # Secret is never deleted, so that is what the docs ask for.
    wrangler = tomllib.loads((ROOT / "relay" / "wrangler.toml").read_text())
    assert wrangler.get("keep_vars") is True, "keep_vars belongs at the top of wrangler.toml, above [vars]"
    for path in (ROOT / "README.md", ROOT / "relay" / "README.md"):
        dashboard = [
            p for p in paragraphs(path.read_text())
            if "ALLOWED_ORIGINS" in p and re.search(r"Worker's settings|on the Worker|to the Worker", p)
        ]
        assert dashboard, f"{path.name} no longer says where a Worker's ALLOWED_ORIGINS goes"
        for paragraph in dashboard:
            assert "Secret" in paragraph, paragraph


def test_the_weekly_image_rebuild_cannot_reuse_last_weeks_yt_dlp() -> None:
    # A RUN layer's cache key is its command and the layers before it; nothing
    # in it asks PyPI. With the build cache warm and neither base image moved,
    # the weekly rebuild that exists to pick up the newest yt-dlp republished
    # the one already cached. A build argument declared just before the pip
    # install is part of that layer's key, so a new value rebuilds it — and
    # only it and what follows, not ffmpeg.
    lines = (ROOT / "server" / "Dockerfile").read_text().splitlines()
    pip = next(i for i, line in enumerate(lines) if line.startswith("RUN pip install") and "requirements.txt" in line)
    previous_run = max(i for i, line in enumerate(lines[:pip]) if line.startswith("RUN "))
    args = [line.split()[1].split("=")[0] for line in lines[previous_run:pip] if line.startswith("ARG ")]
    assert args, "no build argument between the last layer that should stay cached and the pip install"

    workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "image.yml").read_text())
    steps = workflow["jobs"]["publish"]["steps"]
    build = next(step for step in steps if "docker/build-push-action" in step.get("uses", ""))
    passed = build["with"].get("build-args", "")
    assert any(re.search(rf"^{arg}=\S", passed, re.M) for arg in args), f"image.yml passes none of {args}: {passed!r}"


def test_the_daily_measurements_ask_as_this_repositorys_page() -> None:
    # A fork's relay answers only the fork's page. Asked with the Origin of
    # maxgfr.github.io, the owner's relay was measured dead every day, and
    # what the log reported was a refusal the measurement had caused.
    for name, script in (("relay-config.yml", "scripts/relay-config.mjs"), ("instances.yml", "scripts/instances.mjs")):
        workflow = yaml.safe_load((ROOT / ".github" / "workflows" / name).read_text())
        runs = [step for job in workflow["jobs"].values() for step in job["steps"] if script in step.get("run", "")]
        assert runs, f"{name} no longer runs {script}"
        for step in runs:
            origin = step.get("env", {}).get("SIPHON_ORIGIN", "")
            assert "vars.SIPHON_ORIGIN" in origin and "github.repository_owner" in origin, f"{name}: {origin!r}"
