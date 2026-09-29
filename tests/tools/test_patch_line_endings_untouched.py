"""An edit rewrites only what it edits: patch (replace mode and V4A) gives the lines it produces
the file's dominant ending, and every other byte — a CRLF past the 4 KB detection window of an LF
file, an LF-only line in a CRLF file, a lone-CR progress line — stays exactly as it was."""

import pytest

from tools.environments.local import LocalEnvironment
from tools.file_operations import ShellFileOperations

_FILLER = "".join(f"line {i}\n" for i in range(700))  # > 4 KB: the ending is detected from here

SHAPES = {
    # LF-dominant; CRLF + lone CR only after the detection window (HTTP fixture, \r progress).
    "lf": (b"status: pending\n" + _FILLER.encode()
           + b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n50%\r100%\n", b"\n"),
    # CRLF-dominant with an LF-only line and a lone CR.
    "crlf": (b"status: pending\r\nb\r\nkeep\n\nlf-only\nprog 1\r2\r\n", b"\r\n"),
}


@pytest.mark.parametrize("shape", SHAPES)
@pytest.mark.parametrize("mode", ["replace", "v4a"])
def test_patch_rewrites_only_the_edited_line(tmp_path, shape, mode):
    original, ending = SHAPES[shape]
    target = tmp_path / "data.txt"
    target.write_bytes(original)
    ops = ShellFileOperations(LocalEnvironment(cwd=str(tmp_path)), cwd=str(tmp_path))

    if mode == "replace":
        result = ops.patch_replace(str(target), "status: pending", "status: done")
    else:
        result = ops.patch_v4a(
            f"*** Begin Patch\n*** Update File: {target}\n-status: pending\n+status: done\n*** End Patch")

    assert result.success, result.error
    first_eol = original.index(ending) + len(ending)
    assert target.read_bytes() == b"status: done" + ending + original[first_eol:]
