"""Local update timings survive the selected-Python handoff without changing outcomes."""

import json
from copy import deepcopy
from pathlib import Path
import shutil
import subprocess
import textwrap
from types import SimpleNamespace

import pytest

from hermes_cli import update_cmd, update_completion, update_receipt
from tests.hermes_cli.test_update_completion_process import transition as transition


@pytest.fixture
def timed_transition(transition, monkeypatch):
    root, _, _, _, request = transition
    package = root / "hermes_cli"
    for name in ("update_completion.py", "update_receipt.py", "source_build.py",
                 "update_stage.py", "update_serve_obligations.py"):
        shutil.copy2(Path(update_completion.__file__).with_name(name), package / name)
    # Exercise the real receipt writer and its filesystem primitive in the tiny
    # transition fixture, whose PM/application adapters deliberately have no deps.
    from pm import filesystem

    shutil.copy2(filesystem.__file__, root / "pm/filesystem.py")
    (package / "runtime_state.py").write_text(
        "from pm.filesystem import durable_write_bytes as _atomic_bytes\n", encoding="utf-8")
    with (root / "hermes_constants.py").open("a", encoding="utf-8") as stream:
        stream.write("get_hermes_home = get_process_hermes_home\n")
    (package / "main_install_repair.py").write_text(
        "_install_configured_features_missing_deps = lambda root: None\n", encoding="utf-8")
    (package / "memory_provider_migration.py").write_text(
        "migrate_all_homes = lambda: None\n", encoding="utf-8")
    # Keep product orchestration real; only the heavyweight compilers are tiny
    # actual subprocesses. Their exit status and receipt writes remain real.
    with (package / "source_build.py").open("a", encoding="utf-8") as stream:
        stream.write(textwrap.dedent("""
            def source_build_env(*args, **kwargs):
                return dict(os.environ)
            def source_frontends(root):
                return ("ui-tui", "web")
            def source_product_current(*args):
                return False
            def fixture_compile(name):
                from hermes_cli.probe import event
                event(name)
                failed = os.environ.get("TIMING_FAILURE") == name
                subprocess.run([sys.executable, "-I", "-S", "-c",
                                "raise SystemExit(" + ("23" if failed else "0") + ")"], check=True)
            def prepare_source_dependencies(*args, **kwargs):
                fixture_compile("node_deps")
            def build_source_tui(*args, **kwargs):
                fixture_compile("tui_build")
            def build_source_web(*args, **kwargs):
                fixture_compile("web_build")
            """))
    # The fixture's request normally selects Desktop, which is unrelated to the
    # interpreter handoff contract being checked here.
    request["desktop"] = False
    monkeypatch.delenv("HERMES_UPDATE_STATUS_FILE", raising=False)
    return root, request


@pytest.mark.parametrize("failure", [None, "python_deps", "web_build"])
def test_real_completion_carries_operation_times_and_preserves_failures(timed_transition, monkeypatch, failure):
    root, request = timed_transition
    if failure == "python_deps":
        (root / "pm/__init__.py").write_text(
            "import subprocess\ndef sync_venv(**kw):\n"
            "    raise subprocess.CalledProcessError(23, ['sync'])\n", encoding="utf-8")
    elif failure:
        monkeypatch.setenv("TIMING_FAILURE", failure)

    result = update_completion.run_completion(request)

    assert result["exit_code"] == (23 if failure else 0)
    data = result["preparation_receipt"] if failure == "python_deps" else result["receipt"]
    assert data["update_id"] == request["receipt"]["update_id"]
    durations = {row["name"]: row for row in data.get("durations", [])}
    expected = {"pm_tools", "python_deps"}
    if failure != "python_deps":
        expected |= {"node_tools", "node_deps", "tui_build", "web_build"}
    assert set(durations) == expected
    assert all(row["duration_ms"] >= 0 for row in durations.values())
    for name, row in durations.items():
        assert row["outcome"] == ("failed" if name == failure else "success")
    if failure == "python_deps":
        assert result["receipt"] is None
        assert data["outcome"] == "running"  # the parent still owns failure finalization
    else:
        saved = json.loads((Path(request["home"]) / "logs/update_receipts/latest.json").read_text())
        assert saved["durations"] == data["durations"]
        assert saved["outcome"] == ("failed" if failure else "success")
    events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
    if not failure:
        by_name = {row["name"]: row for row in events}
        assert by_name["tools"]["pid"] != by_name["tui_build"]["pid"]
    else:
        assert "maintenance" not in {row["name"] for row in events}


def test_duration_uses_monotonic_time_and_never_changes_operation_or_metrics(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(update_receipt, "_code_identity", lambda **kwargs: {})
    ticks = iter([10.0, 11.25, 20.0, 20.5, 30.0, 30.25])
    # Keep the controlled clock local: patching the shared time module breaks
    # asyncio/pytest teardown after these finite ticks have been consumed.
    monkeypatch.setattr(update_receipt, "time", SimpleNamespace(monotonic=lambda: next(ticks)))
    with update_receipt.update_receipt_scope():
        update_receipt.begin_update_receipt()
        update_receipt.record_stage("apply", "success", mode="git")
        stages = update_receipt._current.get().data["stages"]
        monkeypatch.setattr(update_receipt, "_utc_now_iso", lambda: "2000-01-01T00:00:00+00:00")
        with update_receipt.measure_duration("returned_failure") as span:
            span["outcome"] = "failed"
        error = subprocess.CalledProcessError(23, ["fixture"])
        with pytest.raises(subprocess.CalledProcessError) as caught:
            with update_receipt.measure_duration("raised_failure"):
                raise error
        assert caught.value is error
        data = update_receipt._current.get().data
        assert data["durations"] == [
            {"name": "returned_failure", "outcome": "failed", "duration_ms": 1250.0},
            {"name": "raised_failure", "outcome": "failed", "duration_ms": 500.0},
        ]
        assert data["stages"] == stages
        assert "durations" not in update_receipt._metric_receipt(data)

        def cannot_record(*args):
            raise OSError("receipt unavailable")

        monkeypatch.setattr(update_receipt, "record_duration", cannot_record)
        with pytest.raises(subprocess.CalledProcessError) as caught:
            with update_receipt.measure_duration("unwritable_receipt"):
                raise error
        assert caught.value is error


@pytest.mark.parametrize("snapshot", ["matching", "foreign", "terminal"])
def test_bootstrap_failure_timings_keep_parent_receipt_and_failure_owner(tmp_path, monkeypatch, snapshot):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(update_receipt, "_code_identity", lambda **kwargs: {})
    monkeypatch.setattr(update_cmd, "_unrestored_autostash_notice", lambda: "")
    monkeypatch.setattr(update_cmd, "_write_fleet_restart_pending_marker", lambda **kwargs: None)
    monkeypatch.setattr(update_cmd, "_accept_completion_pm_receipt", lambda *args: None)
    result_path = tmp_path / "bootstrap-result.json"

    def failed_bootstrap(request):
        child = deepcopy(request["receipt"])
        child["durations"].append({"name": "python_deps", "outcome": "failed", "duration_ms": 250.0})
        update_completion._failed_result({**request, "receipt": child}, result_path, 23)
        result = json.loads(result_path.read_text(encoding="utf-8"))
        preparation = result["preparation_receipt"]
        if snapshot == "foreign":
            preparation["update_id"] = "foreign-update"
        elif snapshot == "terminal":
            preparation["finished_at"] = "2026-10-03T00:00:00+00:00"
        return result

    monkeypatch.setattr(update_cmd, "run_completion", failed_bootstrap)
    with update_receipt.update_receipt_scope():
        update_receipt.begin_update_receipt()
        update_receipt.record_duration("git_fetch", "success", 125.0)
        identity = update_receipt.current_correlation_id()
        source_durations = deepcopy(update_receipt._current.get().data["durations"])
        request = {"windows_resume": None, "expected_sha": "f" * 40}

        with pytest.raises(SystemExit) as error:
            update_cmd._complete_source_update(request)

        assert error.value.code == 23
        pending = update_receipt._current.get().data
        assert pending["update_id"] == identity
        assert pending["outcome"] == "running" and pending["finished_at"] is None
        expected = source_durations + ([{
            "name": "python_deps", "outcome": "failed", "duration_ms": 250.0,
        }] if snapshot == "matching" else [])
        assert pending["durations"] == expected
        path = update_receipt.finalize_pending_update_receipt(error.value.code, "bootstrap failed")
        assert path is not None
        saved = json.loads(path.read_text(encoding="utf-8"))
        assert saved["update_id"] == identity
        assert saved["outcome"] == "failed" and saved["exit_code"] == 23
        assert saved["durations"] == expected
        assert update_receipt._current.get() is None


def test_local_git_timing_preserves_return_codes_and_check_exception(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(update_receipt, "_code_identity", lambda **kwargs: {})
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    git = shutil.which("git")
    assert git is not None, "local Git timing check requires the Git used by source-update tests"
    command = ["hermes-nonexistent-subcommand"]
    with update_receipt.update_receipt_scope():
        update_receipt.begin_update_receipt()

        successful = update_cmd._git_run([git], ["init", "--quiet"], cwd=checkout, check=True)
        failed = update_cmd._git_run([git], command, cwd=checkout)
        with pytest.raises(subprocess.CalledProcessError) as error:
            update_cmd._git_run([git], command, cwd=checkout, check=True)

        assert successful.returncode == 0 and (checkout / ".git").is_dir()
        assert failed.returncode != 0 and failed.stderr
        assert error.value.returncode == failed.returncode
        assert error.value.cmd == failed.args == [git, *command]
        rows = update_receipt._current.get().data["durations"]
        assert [(row["name"], row["outcome"]) for row in rows] == [
            ("git_init", "success"), (f"git_{command[0]}", "failed"), (f"git_{command[0]}", "failed"),
        ]
        assert all(row["duration_ms"] >= 0 for row in rows)
