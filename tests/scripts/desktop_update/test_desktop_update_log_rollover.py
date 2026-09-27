"""The hand-off log rolls over before a run instead of growing forever.

Every hand-off appends the whole `hermes update` output to
logs/desktop-update-handoff.log. Pinned against the real `posix.sh`: an
oversized log moves to `.1` and the new run starts a fresh file.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
SHIM_DIR = REPO_ROOT / "scripts" / "desktop-update"

FAKE_HERMES = """#!/usr/bin/env bash
case "$*" in *--help*) echo "--keep-stash"; exit 0 ;; esac
exit 0
"""


@pytest.mark.skipif(
    not (os.path.exists("/bin/bash") and os.path.exists("/usr/bin/python3")),
    reason="posix.sh detaches through /bin/bash and /usr/bin/python3",
)
def test_oversized_handoff_log_rolls_over_before_the_run(tmp_path):
    install_root = tmp_path / "hermes-agent"
    (install_root / "venv" / "bin").mkdir(parents=True)
    hermes = install_root / "venv" / "bin" / "hermes"
    hermes.write_text(FAKE_HERMES)
    hermes.chmod(0o755)
    log = tmp_path / "logs" / "desktop-update-handoff.log"
    log.parent.mkdir()
    previous = "old hand-off output\n" * 280_000  # past the 5 MiB ceiling
    log.write_text(previous)

    env = {**os.environ, "TMPDIR": str(tmp_path), "HERMES_HOME": str(tmp_path)}
    subprocess.run(["/bin/bash", str(SHIM_DIR / "posix.sh"), "--install-root", str(install_root), "--no-ui"],
                   env=env, timeout=60, check=True)
    result = tmp_path / ".hermes-update-result.json"
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline and not result.exists():
        time.sleep(0.1)
    assert result.exists(), "hand-off never wrote its result file"

    assert (tmp_path / "logs" / "desktop-update-handoff.log.1").read_text() == previous
    fresh = log.read_text()
    assert "hand-off start:" in fresh.splitlines()[0]
    assert "old hand-off output" not in fresh
