"""Desktop staging belongs to one live builder and one host architecture."""

from pathlib import Path

from hermes_cli import main_desktop


def test_staging_gc_keeps_another_live_owner(tmp_path, monkeypatch):
    desktop = tmp_path / "desktop"
    desktop.mkdir()
    live = desktop / ".staging-42-arm64-aaaaaaaaaaaa-1"
    dead = desktop / ".staging-43-arm64-bbbbbbbbbbbb-1"
    legacy = desktop / ".staging-old"
    for candidate in (live, dead, legacy):
        candidate.mkdir()

    monkeypatch.setattr(main_desktop.os, "getpid", lambda: 99)
    monkeypatch.setattr(main_desktop, "_desktop_staging_owner_alive", lambda pid: pid == 42)
    monkeypatch.setattr(main_desktop, "_desktop_staging_arch", lambda: "arm64")

    created = main_desktop._desktop_staging_dir(desktop)

    assert live.exists()
    assert not dead.exists()
    assert legacy.exists()
    assert created.name.startswith(".staging-99-arm64-")


def test_staging_identity_binds_path_affecting_user_data_roots(tmp_path, monkeypatch):
    desktop = tmp_path / "desktop"
    desktop.mkdir()
    monkeypatch.setattr(main_desktop.os, "getpid", lambda: 99)
    monkeypatch.setattr(main_desktop, "_desktop_staging_arch", lambda: "x64")
    monkeypatch.setattr(main_desktop._time_mod, "time", lambda: 1)

    first = main_desktop._desktop_staging_dir(
        desktop, env={"HERMES_HOME": str(tmp_path / "one")}
    )
    second = main_desktop._desktop_staging_dir(
        desktop, env={"HERMES_HOME": str(tmp_path / "two")}
    )

    assert first.name != second.name
    assert first.name.endswith("-1")
    assert second.name.endswith("-1")


def test_packaged_executable_prefers_matching_architecture(tmp_path, monkeypatch):
    release = tmp_path / "release"
    arm = release / "linux-arm64-unpacked" / "hermes"
    stale_x64 = release / "linux-unpacked" / "hermes"
    arm.parent.mkdir(parents=True)
    stale_x64.parent.mkdir(parents=True)
    arm.write_text("arm", encoding="utf-8")
    stale_x64.write_text("x64", encoding="utf-8")
    stale_x64.touch()

    monkeypatch.setattr(main_desktop.sys, "platform", "linux")
    monkeypatch.setattr(main_desktop, "_desktop_staging_arch", lambda: "arm64")

    assert main_desktop._desktop_packaged_executable_in(release) == arm
