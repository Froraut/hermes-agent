#!/usr/bin/env python3
"""Disposable local Git/completion benchmark; this is not a full installed update.

Run with Python 3.11+ and Git on PATH. No downloads or installed Hermes state are used.
The copied updater transport, completion tail, lock and durable receipt writer are real;
PM/dependency, product-build, launcher and maintenance boundaries are fixture adapters.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import importlib.util
import io, json, os
from pathlib import Path
import platform, shutil, subprocess, sys, tempfile, time, uuid, venv

REAL_FILES = (
    "hermes_cli/__init__.py", "hermes_cli/update_completion.py",
    "hermes_cli/source_completion.py", "hermes_cli/update_lock.py",
    "hermes_cli/update_receipt.py", "hermes_cli/runtime_state.py", "pm/filesystem.py",
)
ADAPTERS = [
    "PM tool/dependency sync and generation cleanup: event-only adapters",
    "PM selection: separate empty stdlib venv; no Hermes dependencies installed",
    "Launcher publication: event-only; no PATH, registry or launcher writes",
    "Frontend/Desktop builds, maintenance and install stamp: event-only adapters",
    "Service recovery and bytecode sweep: event-only; gateway restart deferred",
    "Code identity: local Git SHA adapter; telemetry disabled; no fleet inventory",
]
EXCLUSIONS = [
    "Fixture setup, private venv creation, initial clones, post-run verification and scratch cleanup",
    "Internet transfer, GitHub latency, large history and real source checkout size",
    "Dependency resolution/download/install, frontend bundling and Desktop packaging",
    "Snapshots, native updater handoff, live processes, service restart and ready/health checks",
    "Production Hermes home, PM store, node_modules, runtime and Windows user registry",
]


def fixture(root: Path, source: Path, selected_python: Path) -> None:
    """Use the minimal independent completion-fixture pattern, without importing pytest."""
    for relative in REAL_FILES:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, target)
    modules = {
        "hermes_cli/probe.py": (
            "import json, os, sys\nfrom pathlib import Path\n"
            "def event(name, **facts):\n"
            "    row = dict(name=name, pid=os.getpid(), parent_pid=os.getppid(), python=sys.executable,\n"
            "               payload=(Path(__file__).resolve().parents[1] / 'payload.txt').read_text(), **facts)\n"
            "    with (Path(os.environ['HERMES_HOME']) / 'events.jsonl').open('a', encoding='utf-8') as f:\n"
            "        f.write(json.dumps(row) + '\\n')\n"
        ),
        "pm/__init__.py": "from hermes_cli.probe import event\nsync_venv = lambda **kw: event('dependency_adapter')\n",
        "pm/client.py": "from hermes_cli.probe import event\nensure_tools_for_sync = lambda: event('tools_adapter')\n",
        "pm/receipt.py": (
            "from contextlib import nullcontext\nworker_context = lambda update_id: nullcontext()\n"
            "last_for_update = lambda update_id, **kw: {'update_id': update_id, 'outcome': 'success'}\n"
            "def accept_worker_receipt(data, update_id):\n    assert data['update_id'] == update_id\n"
        ),
        "pm/environments.py": (
            "import os\nfrom pathlib import Path\nfrom hermes_cli.probe import event\n"
            f"project_python = lambda root: Path({str(selected_python)!r})\n"
            "activation_environment = lambda root: dict(os.environ)\n"
            "activate_dependencies = lambda root: event('selected_python')\n"
            "dependency_home_root = lambda: Path(os.environ['HERMES_RUNTIME_DIR'])\n"
            "install_state_dir = lambda root: dependency_home_root() / 'state'\n"
            "runtime_facts_path = lambda root: install_state_dir(root) / 'facts.json'\n"
        ),
        "hermes_constants.py": (
            "import os\nfrom pathlib import Path\n"
            "get_hermes_home = get_process_hermes_home = lambda: Path(os.environ['HERMES_HOME'])\n"
        ),
        "hermes_cli/venv_sync.py": (
            "from hermes_cli.probe import event\nfrom hermes_constants import get_hermes_home\n"
            "publish_launchers = lambda root: event('launcher_adapter')\n"
            "collect_superseded_generations = lambda root: event('cleanup_adapter')\n"
            "refuse_foreign_owned_venv = lambda root: None\n"
            "arm_completion = lambda root: (get_hermes_home() / 'completion-pending').write_text('owed')\n"
            "clear_completion = lambda root: (get_hermes_home() / 'completion-pending').unlink()\n"
        ),
        "hermes_cli/main.py": "from hermes_cli import config\n",
        "hermes_cli/config.py": "read_raw_config_readonly = lambda: {'telemetry': {'shared_metrics': {'enabled': False}}}\n",
        "hermes_cli/update_cmd_config.py": "_LAST_SIBLING_SNAPSHOTS = {}\n",
        "hermes_cli/update_inventory.py": "from types import SimpleNamespace\nRuntimeRecord = UpdatePlan = SimpleNamespace\n",
        "hermes_cli/_subprocess_compat.py": "expose_pm_git = lambda root: None\n",
        "hermes_cli/source_build.py": "from hermes_cli.probe import event\nbuild_update_products = lambda root, **kw: event('build_adapter', **kw)\n",
        "hermes_cli/source_stamp.py": "from hermes_cli.probe import event\nwrite_source_stamp = lambda root: event('stamp_adapter')\n",
        "hermes_cli/update_cmd_maint.py": "from hermes_cli.probe import event\ndef _run_post_update_maintenance(**kw):\n    event('maintenance_adapter')\n    return True\n",
        "hermes_cli/update_cmd.py": "from hermes_cli.probe import event\n_sweep_bytecode_after_update = lambda branch: event('sweep_adapter')\n_resume_windows_gateways_after_update = lambda token: event('recovery_adapter')\n",
        "hermes_cli/update_serve_obligations.py": "retain_receipt_manual_serves = lambda receipt: []\n",
        "hermes_cli/observability/__init__.py": "",
        "hermes_cli/observability/shared_metrics_update.py": "record_update_receipt = lambda receipt: None\n",
        "hermes_cli/version_info.py": (
            "import subprocess\ndef get_code_identity(refresh=False):\n"
            "    sha = subprocess.run(['git', 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True, timeout=10).stdout.strip()\n"
            "    return {'sha': sha, 'source': 'disposable-benchmark'}\n"
        ),
    }
    for relative, body in modules.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")


def benchmark(scratch: Path) -> dict:
    source = Path(__file__).resolve().parents[2]
    seed, remote, checkout, home = (scratch / name for name in ("seed", "origin.git", "checkout", "home"))
    for path in (seed, home, scratch / "empty-template"):
        path.mkdir()
    # Remove inherited Git/Hermes controls before setting owned homes. Children never select
    # the production PM environment or read user Git hooks/configuration.
    for key in list(os.environ):
        if key.startswith(("GIT_", "HERMES_")) or key in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"):
            os.environ.pop(key)
    private_config = scratch / "gitconfig"
    private_config.write_text("", encoding="utf-8")
    os.environ.update(HOME=str(home), USERPROFILE=str(home), HERMES_HOME=str(home),
                      APPDATA=str(home / "appdata"), LOCALAPPDATA=str(home / "localappdata"),
                      HERMES_RUNTIME_DIR=str(scratch / "runtime"), HERMES_GATEWAY_LOCK_DIR=str(home / "locks"),
                      GIT_CONFIG_GLOBAL=str(private_config), GIT_CONFIG_NOSYSTEM="1", GIT_ALLOW_PROTOCOL="file",
                      GIT_TEMPLATE_DIR=str(scratch / "empty-template"), GIT_TERMINAL_PROMPT="0")
    selected = scratch / "selected-python"
    venv.EnvBuilder(with_pip=False).create(selected)
    selected_python = selected / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    fixture(seed, source, selected_python)

    def git(root: Path, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True,
                              text=True, encoding="utf-8", timeout=30).stdout.strip()

    git(seed, "init", "-b", "main")
    git(seed, "config", "user.name", "Disposable update benchmark")
    git(seed, "config", "user.email", "benchmark@example.invalid")
    for payload in ("before\n", "after\n"):
        (seed / "payload.txt").write_text(payload, encoding="utf-8")
        git(seed, "add", ".")
        git(seed, "-c", "commit.gpgsign=false", "commit", "-m", payload.strip())
        if payload.startswith("before"):
            before = git(seed, "rev-parse", "HEAD")
            git(scratch, "clone", "--bare", "--no-hardlinks", str(seed), str(remote))
            git(scratch, "clone", remote.as_uri(), str(checkout))
    selected_sha = git(seed, "rev-parse", "HEAD")
    git(seed, "push", remote.as_uri(), "main")
    spec = importlib.util.spec_from_file_location("benchmark_transport", checkout / "hermes_cli/update_completion.py")
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)  # loaded from the old tree before the real transition
    durations = {}
    for name, args in (("git_fetch", ("fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main")),
                       ("git_materialization", ("merge", "--ff-only", "origin/main"))):
        started = time.monotonic()
        git(checkout, *args)
        durations[name] = round((time.monotonic() - started) * 1000, 3)
    materialized = git(checkout, "rev-parse", "HEAD")
    if materialized != selected_sha:
        raise RuntimeError("Git did not materialize the selected commit")
    update_id = uuid.uuid4().hex
    request = dict(schema=1, source=str(checkout), home=str(home), branch="main", desktop=True,
                   assume_yes=True, gateway_mode=False, pre_update_version="fixture-before", snapshot_id=None,
                   sibling_snapshots={}, plan=None, windows_resume=None, no_gateway_restart=True,
                   receipt=dict(schema=1, update_id=update_id, started_at=datetime.now(timezone.utc).isoformat(),
                                finished_at=None, pid=os.getpid(), outcome="running", pre_update={"sha": before},
                                post_update={}, steps=[], skips=[], fleet=[], gateway_restart={}))
    output = io.StringIO()
    started = time.monotonic()
    with redirect_stdout(output):
        result = transport.run_completion(request)
    durations["source_completion"] = round((time.monotonic() - started) * 1000, 3)
    event_path = home / "events.jsonl"
    try:
        events = [json.loads(line) for line in event_path.read_text(encoding="utf-8").splitlines()]
    except (OSError, ValueError):
        events = []  # keep the correlated completion response even when observation failed
    activation = next((event for event in events if event["name"] == "selected_python"), {})
    prepare = next((event for event in events if event["name"] == "dependency_adapter"), {})
    build = next((event for event in events if event["name"] == "build_adapter"), {})
    selected_ok = (activation.get("python") == str(selected_python) and activation.get("payload") == "after\n"
                   and activation.get("pid") not in (os.getpid(), prepare.get("pid"))
                   and build.get("pid") == activation.get("pid"))
    receipt = result.get("receipt")
    success = result["exit_code"] == 0 and receipt and receipt.get("outcome") == "success" and selected_ok
    return dict(schema=1, scope="disposable local source transport benchmark; not full installed update",
                platform=platform.platform(), python=sys.version, git=git(checkout, "--version"),
                outcome="success" if success else "failed", exit_code=result["exit_code"] if success else 1,
                durations_ms=durations, measured_total_ms=round(sum(durations.values()), 3),
                timing_note="Monotonic operation durations; measured_total_ms is their sum, excluding setup and gaps.",
                source=dict(before=before, selected=selected_sha, materialized=materialized),
                selected_python_verified=selected_ok, receipt=receipt, events=events,
                completion_exit_code=result["exit_code"], preparation_receipt=result.get("preparation_receipt"),
                completion_log=output.getvalue(), real_helpers=list(REAL_FILES), adapters=ADAPTERS, exclusions=EXCLUSIONS)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="Persist JSON outside the disposable scratch directory.")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="hermes-update-benchmark-") as directory:
        try:
            report = benchmark(Path(directory))
        except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
            report = dict(schema=1, scope="disposable benchmark", outcome="failed", exit_code=1,
                          error=f"{type(exc).__name__}: {exc}", adapters=ADAPTERS, exclusions=EXCLUSIONS)
    payload = json.dumps(report, indent=2) + "\n"
    if args.out:
        args.out.resolve().write_text(payload, encoding="utf-8")
    print(payload, end="")
    return report["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
