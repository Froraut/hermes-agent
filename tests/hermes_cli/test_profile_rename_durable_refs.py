import json

from hermes_cli.profile_identity import migrate_profile_durable_references


def test_temp_profile_rename_migrates_durable_identity_and_path_consumers(tmp_path):
    root = tmp_path / ".hermes"
    old_dir = root / "profiles" / "old-bot"
    new_dir = root / "profiles" / "new-bot"
    new_dir.mkdir(parents=True)
    old_path = str(old_dir)
    (new_dir / "cron").mkdir()
    (new_dir / "cron" / "jobs.json").write_text(json.dumps({"jobs": [{
        "profile": "old-bot", "transport_profile": "old-bot",
        "deliver": "bot-chat:old-bot", "session_key": "agent:old-bot:telegram:dm:1",
        "home": old_path,
    }]}))
    (new_dir / "plugins").mkdir()
    (new_dir / "plugins" / "state.json").write_text(json.dumps({
        "target_profile": "old-bot", "profile_home": old_path,
    }))
    (root / "config.yaml").write_text(
        "routes:\n  - profile: old-bot\n    transport_profile: old-bot\n")

    assert migrate_profile_durable_references(old_dir, new_dir)
    assert migrate_profile_durable_references(old_dir, new_dir)  # retry-safe

    job = json.loads((new_dir / "cron" / "jobs.json").read_text())["jobs"][0]
    assert job == {
        "profile": "new-bot", "transport_profile": "new-bot",
        "deliver": "bot-chat:new-bot", "session_key": "agent:new-bot:telegram:dm:1",
        "home": str(new_dir),
    }
    plugin = json.loads((new_dir / "plugins" / "state.json").read_text())
    assert plugin == {"target_profile": "new-bot", "profile_home": str(new_dir)}
    assert "profile: new-bot" in (root / "config.yaml").read_text()
    assert "transport_profile: new-bot" in (root / "config.yaml").read_text()
