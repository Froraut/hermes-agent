"""Source discovery ends a stalled fetch and its pipe-holding helper, without a traceback."""

import subprocess
import sys
import time

import psutil
import pytest

from hermes_cli import update_cmd


def test_check_timeout_reaps_fetch_helper_and_reports_failure(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", str(repo)], check=True, timeout=10)
    marker = tmp_path / "fetch-helper.pid"
    shim = tmp_path / "git.py"
    shim.write_text(
        "import subprocess, sys, time\n"
        "from pathlib import Path\n"
        "marker, args = Path(sys.argv[1]), sys.argv[2:]\n"
        "if args[0] == 'fetch':\n"
        "    child = subprocess.Popen([sys.executable, '-I', '-S', '-c', 'import time; time.sleep(15)'])\n"
        "    marker.write_text(str(child.pid))\n"
        "    time.sleep(8)\n"
        "elif args == ['rev-parse', '--is-shallow-repository']:\n"
        "    print('false')\n"
        "else:\n"
        "    sys.exit(1)\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(update_cmd._m(), "PROJECT_ROOT", repo)
    monkeypatch.setattr("hermes_cli.update_contract.evaluate_update_admission", lambda root: None)
    monkeypatch.setattr(update_cmd, "_base_git_cmd", lambda: [sys.executable, "-I", "-S", str(shim), str(marker)])
    monkeypatch.setattr(update_cmd, "NETWORK_GIT_TIMEOUT_SECONDS", 1)
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)

    helper = None

    def helper_running():
        try:
            return helper is not None and helper.is_running() and helper.status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False

    started = time.monotonic()
    try:
        with pytest.raises(SystemExit) as failed:
            update_cmd._cmd_update_check("main", branch_explicit=True)
        assert failed.value.code == 1
        assert marker.exists(), "the fake remote must have started its real pipe-holding helper"
        try:
            helper = psutil.Process(int(marker.read_text()))
        except psutil.NoSuchProcess:
            pass
        deadline = time.monotonic() + 3
        while helper_running():
            assert time.monotonic() < deadline, "fetch helper survived the update-check timeout"
            time.sleep(0.05)
        assert time.monotonic() - started < 6, "the check must end without waiting for the stalled fetch"
        out = capsys.readouterr().out
        assert "git fetch timed out" in out
        assert "Already up to date" not in out and "not found on" not in out
    finally:
        # A regression must not leak the fixture's 15-second helper.
        if helper is None and marker.exists():
            try:
                helper = psutil.Process(int(marker.read_text()))
            except psutil.NoSuchProcess:
                pass
        if helper_running():
            helper.kill()
            helper.wait(timeout=5)
