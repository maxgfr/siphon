"""
The converter beside the app: what scripts/vendor_ffmpeg.py accepts and refuses.

Against a tarball built here, not the registry: the integrity check and the
extraction are what matter, and both are pure once the bytes are in hand.
"""
import base64
import hashlib
import io
import sys
import tarfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import vendor_ffmpeg  # noqa: E402


def tarball(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(f"package/{name}")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def integrity(data: bytes) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


CORE = {
    "dist/umd/ffmpeg-core.js": b"// loader",
    "dist/umd/ffmpeg-core.wasm": b"\0asm\1\0\0\0",
    "package.json": b"{}",
    "dist/esm/ffmpeg-core.js": b"// not wanted",
}


def test_the_registry_hash_is_checked_before_anything_is_written(tmp_path):
    data = tarball(CORE)
    vendor_ffmpeg.check_integrity(data, integrity(data))
    with pytest.raises(SystemExit, match="integrity mismatch"):
        vendor_ffmpeg.check_integrity(data + b"x", integrity(data))
    with pytest.raises(SystemExit, match="unexpected integrity format"):
        vendor_ffmpeg.check_integrity(data, "sha1-abc")


def test_only_the_two_umd_files_are_extracted(tmp_path):
    written = vendor_ffmpeg.extract(tarball(CORE), tmp_path)
    assert sorted(p.name for p in written) == ["ffmpeg-core.js", "ffmpeg-core.wasm"]
    assert (tmp_path / "ffmpeg-core.wasm").read_bytes().startswith(b"\0asm")
    assert not (tmp_path / "package.json").exists()


def test_a_tarball_missing_the_core_is_refused(tmp_path):
    with pytest.raises(KeyError):
        vendor_ffmpeg.extract(tarball({"package.json": b"{}"}), tmp_path)


def test_a_second_run_with_the_same_version_in_place_does_not_download(tmp_path, monkeypatch):
    for name in ("ffmpeg-core.js", "ffmpeg-core.wasm"):
        (tmp_path / name).write_bytes(b"x")
    (tmp_path / "VERSION").write_text(f"{vendor_ffmpeg.VERSION}\n")

    def no_network(url):
        raise AssertionError(f"should not fetch {url}")

    monkeypatch.setattr(vendor_ffmpeg, "fetch", no_network)
    assert vendor_ffmpeg.main(tmp_path) == 0


def test_a_different_version_in_place_is_replaced(tmp_path, monkeypatch):
    (tmp_path / "VERSION").write_text("0.0.1\n")
    data = tarball(CORE)
    answers = {
        f"{vendor_ffmpeg.REGISTRY}/{vendor_ffmpeg.PACKAGE}/{vendor_ffmpeg.VERSION}": (
            '{"dist": {"tarball": "https://registry.example/core.tgz", "integrity": "%s"}}' % integrity(data)
        ).encode(),
        "https://registry.example/core.tgz": data,
    }
    monkeypatch.setattr(vendor_ffmpeg, "fetch", lambda url: answers[url])
    assert vendor_ffmpeg.main(tmp_path) == 0
    assert (tmp_path / "VERSION").read_text().strip() == vendor_ffmpeg.VERSION
    assert (tmp_path / "ffmpeg-core.js").read_bytes() == b"// loader"
