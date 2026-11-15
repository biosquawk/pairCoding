#!/usr/bin/env python3
"""Export all of src/ and scripts/ to ingest/src.md and ingest/scripts.md.

Run: python3 review.py (also works from another current directory).
Inspired by the owner's read-only reviewFixed.py: stable paths, complete payloads,
byte counts and SHA-256. No dependencies, model calls, truncation or file filters.
UTF-8 is preserved byte-for-byte; other files are included in full as Base64.
Symlinks and special files fail explicitly rather than reading outside the inputs.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
INPUTS = ("src", "scripts")


def collect(root: Path, name: str) -> list[tuple[str, bytes]]:
    source = root / name
    if source.is_symlink() or not source.is_dir():
        raise ValueError(f"Expected a real input directory: {source}")
    entries = []
    for file in sorted(source.rglob("*")):
        info = file.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"Symlink or special file cannot be exported: {file}")
        with file.open("rb") as stream:
            before = os.fstat(stream.fileno())
            raw = stream.read()
            after = os.fstat(stream.fileno())
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError(f"File changed during export: {file}; retry")
        entries.append((file.relative_to(root).as_posix(), raw))
    return entries


def render(name: str, entries: list[tuple[str, bytes]]) -> bytes:
    result = [f"# {name}\n\nComplete recursive export: {len(entries)} files.\n\n".encode()]
    for relative, raw in entries:
        encoding, payload = "utf-8", raw
        try:
            raw.decode("utf-8")
            if b"\x00" in raw:
                raise ValueError("Binary NUL")
        except (UnicodeDecodeError, ValueError):
            encoding, payload = "base64", base64.b64encode(raw)
        fence = b"`" * max(3, 1 + max((len(m.group()) for m in re.finditer(rb"`+", payload)), default=0))
        metadata = {"path": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                    "encoding": encoding, "payloadBytes": len(payload)}
        result.extend([
            f"## {json.dumps(relative, ensure_ascii=False)}\n\n".encode(),
            ("<!-- REVIEW_FILE " + json.dumps(metadata, ensure_ascii=False) + " -->\n").encode(),
            fence + (b"base64" if encoding == "base64" else b"text") + b"\n",
            payload, b"\n" + fence + b"\n<!-- REVIEW_END -->\n\n",
        ])
    return b"".join(result)


def export(root: Path = ROOT) -> list[dict]:
    # Read both complete inputs before publishing either output.
    inputs = {name: collect(root, name) for name in INPUTS}
    output = root / "ingest"
    if output.is_symlink():
        raise ValueError(f"Output directory must not be a symlink: {output}")
    output.mkdir(mode=0o700, exist_ok=True)
    staging: list[tuple[Path, Path]] = []
    summaries = []
    try:
        for name, entries in inputs.items():
            target = output / f"{name}.md"
            if target.is_symlink() or (target.exists() and not target.is_file()):
                raise ValueError(f"Expected a regular output file: {target}")
            data = render(name, entries)
            with tempfile.NamedTemporaryFile(dir=output, prefix=".review-", delete=False) as stream:
                temporary = Path(stream.name)
                staging.append((temporary, target))
                stream.write(data)
            summaries.append({"output": str(target), "files": len(entries),
                              "sourceBytes": sum(len(raw) for _, raw in entries), "outputBytes": len(data)})
        for name in INPUTS:
            if collect(root, name) != inputs[name]:
                raise ValueError(f"Sources in {name} changed during export; retry")
        for temporary, target in staging:
            os.replace(temporary, target)
    finally:
        for temporary, _ in staging:
            temporary.unlink(missing_ok=True)
    return summaries


def main() -> int:
    if len(sys.argv) != 1:
        print("Run without arguments: python3 review.py", file=sys.stderr)
        return 2
    try:
        for summary in export():
            print(json.dumps(summary, ensure_ascii=False))
        return 0
    except (OSError, ValueError) as error:
        print(f"review.py: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
