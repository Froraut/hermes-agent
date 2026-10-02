"""Update tool preparation shares one worker and lock-scoped byte verification."""
from __future__ import annotations

from collections import Counter
import importlib.util
import json
import os
import sys
import textwrap

import pytest

from pm import paths, registry
from pm.lock import Facts, Lockfile
from pm.store import Store, current_target, tree_digest
from tests.pm._fixtures import (
    client as client,
    isolated_python as isolated_python,
    make_tar,
    served as served,
)


@pytest.fixture
def installed_tools(client, tmp_path, monkeypatch, served):
    docroot, base_url = served
    trace = tmp_path / "verified.jsonl"
    source = tmp_path / "sync_tool_packages.py"
    source.write_text(textwrap.dedent(f"""\
        import json
        import os
        from pathlib import Path
        from pm import Package
        from pm.filesystem import lock_fd

        class Shared(Package):
            name = "sync-shared"
            internal = True

            def verify(self, entry, target):
                fd = os.open(entry.parent / ".install.lock", os.O_CREAT | os.O_RDWR, 0o600)
                try:
                    locked = not lock_fd(fd, wait=False)
                finally:
                    os.close(fd)
                with Path({str(trace)!r}).open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps({{"name": self.name, "pid": os.getpid(), "locked": locked}}) + "\\n")
                return "" if (entry / "payload.txt").is_file() else "missing payload"

        class First(Shared):
            name = "sync-first"
            internal = False
            deps = ("sync-shared",)

        class Second(First):
            name = "sync-second"
        """), encoding="utf-8")
    spec = importlib.util.spec_from_file_location("sync_tool_packages", source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    registry.all_packages()
    monkeypatch.setattr(registry, "_packages", dict(registry._packages))
    packages = [cls() for cls in (module.Shared, module.First, module.Second)]
    for package in packages:
        registry._packages[package.name] = package
    lock = Lockfile(paths.lockfile_path())
    target = current_target()
    store = Store(paths.store_root())
    for package in packages:
        archive, digest = make_tar(docroot, f"{package.name}.tar.gz", {"payload.txt": "good"})
        lock.set_pin(package.name, "1", {target: {
            "url": f"{base_url}/{archive}", "sha256": digest,
        }})
        entry = store.entry(package.store_entry("1", target))
        entry.mkdir(parents=True)
        (entry / "payload.txt").write_text("good", encoding="utf-8")
        with store.install_lock():
            Facts(paths.facts_path()).record(
                package.name, "1", entry.name, package.env(entry, target), store.root,
                target=target, artifacts=[digest], digest=tree_digest(entry),
            )
    lock.save()
    monkeypatch.setattr(client, "is_runtime", lambda: False)
    return client, store, trace


def test_update_tools_share_one_worker_and_verify_common_bytes_once(installed_tools):
    client, _, trace = installed_tools

    client.ensure_tools_for_sync()

    verified = [json.loads(line) for line in trace.read_text(encoding="utf-8").splitlines()]
    assert Counter(row["name"] for row in verified) == {
        "sync-shared": 1, "sync-first": 1, "sync-second": 1,
    }
    assert len({row["pid"] for row in verified}) == 1
    assert verified[0]["pid"] != os.getpid()
    assert all(row["locked"] for row in verified)


def test_next_update_rechecks_and_repairs_same_size_same_time_corruption(installed_tools):
    client, store, _ = installed_tools
    client.ensure_tools_for_sync()
    fact = Facts(paths.facts_path()).get("sync-shared")
    assert fact is not None
    payload = store.entry(fact["entry"]) / "payload.txt"
    previous = payload.stat()
    with store.install_lock():
        payload.write_text("evil", encoding="utf-8")
        os.utime(payload, ns=(previous.st_atime_ns, previous.st_mtime_ns))

    client.ensure_tools_for_sync()

    assert payload.read_text(encoding="utf-8") == "good"
    repaired = Facts(paths.facts_path()).get("sync-shared")
    assert repaired is not None
    assert repaired["digest"] == tree_digest(store.entry(repaired["entry"]))
