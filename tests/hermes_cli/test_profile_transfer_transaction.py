import os
import tarfile
from pathlib import Path

import pytest

from hermes_cli import profiles


def _archive(path: Path, root: str = "incoming") -> Path:
    payload = path.parent / "config.yaml"
    payload.write_text("model: test\n", encoding="utf-8")
    with tarfile.open(path, "w:gz") as tf:
        tf.add(payload, arcname=f"{root}/config.yaml")
    return path


def test_profile_transfer_rejects_escaping_sources_and_publishes_atomically(tmp_path, monkeypatch):
    profiles_root = tmp_path / "profiles"
    source = profiles_root / "source"
    source.mkdir(parents=True)
    outside = tmp_path / "outside.txt"
    outside.write_text("private", encoding="utf-8")
    (source / "escape").symlink_to(outside)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)
    monkeypatch.setattr(profiles, "get_profile_dir", lambda name: profiles_root / name)
    monkeypatch.setattr(profiles, "validate_profile_name", lambda name: None)

    with pytest.raises(ValueError, match="escapes profile root"):
        profiles.export_profile("source", str(tmp_path / "export.tar.gz"))

    archive = _archive(tmp_path / "incoming.tar.gz")
    real_rename = os.rename
    calls = []

    def rename_on_destination_filesystem(src, dst):
        calls.append((Path(src), Path(dst)))
        assert Path(src).parent.parent == profiles_root
        real_rename(src, dst)

    monkeypatch.setattr(profiles.os, "rename", rename_on_destination_filesystem)
    imported = profiles.import_profile(str(archive), name="published")

    assert imported == profiles_root / "published"
    assert (imported / "config.yaml").read_text(encoding="utf-8") == "model: test\n"
    assert calls
    assert calls[-1][1] == imported
    assert not any(p.name.startswith(".published.import-") for p in profiles_root.iterdir())
