#!/usr/bin/env python3
"""
Put ffmpeg.wasm beside the app, so nobody has to configure where it comes from.

The converter is @ffmpeg/core on npm: one JavaScript loader and one 31 MB
wasm file. Fetching them from a CDN at first use works — until the CDN is
blocked, slow, or down, at which point a download that needs converting
fails with a sentence about a URL nobody asked to know about. Deployed
beside the page they are same-origin: nothing to configure, no CORS, cached
by the service worker like everything else, and the Docker image is
self-contained.

This is run by the Pages deploy and the image build, never committed: a
31 MB binary in git would be paid for by every clone forever. Locally,
`python3 scripts/vendor_ffmpeg.py` does the same for the test suites.

The tarball is pinned by version and checked against the integrity hash the
registry publishes for it, so a wrong or tampered download is refused rather
than served.
"""
import base64
import hashlib
import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSION = "0.12.10"
PACKAGE = "@ffmpeg/core"
REGISTRY = "https://registry.npmjs.org"
FILES = ("dist/umd/ffmpeg-core.js", "dist/umd/ffmpeg-core.wasm")
TARGET = Path(__file__).resolve().parent.parent / "web" / "vendor" / "ffmpeg"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "*/*"}), timeout=120) as response:
        return response.read()


def check_integrity(data: bytes, integrity: str) -> None:
    """`sha512-<base64>` is what npm publishes; anything else is refused, not skipped."""
    algorithm, _, expected = integrity.partition("-")
    if algorithm != "sha512" or not expected:
        raise SystemExit(f"unexpected integrity format: {integrity!r}")
    actual = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != expected:
        raise SystemExit(f"integrity mismatch for {PACKAGE}@{VERSION}: got {actual}, registry says {expected}")


def extract(tarball: bytes, target: Path) -> list[Path]:
    """The two UMD files, and nothing else the tarball carries."""
    target.mkdir(parents=True, exist_ok=True)
    written = []
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
        for wanted in FILES:
            member = archive.getmember(f"package/{wanted}")
            data = archive.extractfile(member)
            if data is None:
                raise SystemExit(f"{wanted} is not a file in the tarball")
            out = target / Path(wanted).name
            out.write_bytes(data.read())
            written.append(out)
    return written


def main(target: Path = TARGET) -> int:
    marker = target / "VERSION"
    if marker.exists() and marker.read_text().strip() == VERSION and all((target / Path(f).name).exists() for f in FILES):
        print(f"{PACKAGE}@{VERSION} already in {target}")
        return 0
    meta = json.loads(fetch(f"{REGISTRY}/{PACKAGE}/{VERSION}"))
    dist = meta["dist"]
    tarball = fetch(dist["tarball"])
    check_integrity(tarball, dist["integrity"])
    for path in extract(tarball, target):
        print(f"  {path.relative_to(target.parent.parent)}  {path.stat().st_size:,} bytes")
    marker.write_text(f"{VERSION}\n")
    print(f"{PACKAGE}@{VERSION} in {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
