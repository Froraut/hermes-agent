"""Session-owned recovery artifacts follow the SessionDB lifecycle."""

from __future__ import annotations

import json
import time

from hermes_state import SessionDB


def _write_artifacts(home, session_id: str, token: str):
    sessions_dir = home / "sessions"
    pending_dir = home / "pending_messages"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    pending_dir.mkdir(parents=True, exist_ok=True)
    request_dump = sessions_dir / f"request_dump_{session_id}_{token}.json"
    emergency_archive = pending_dir / f"pending-{token}.json"
    request_dump.write_text("{}", encoding="utf-8")
    emergency_archive.write_text(json.dumps({
        "reason": "shutdown-with-unpersisted-agent-history",
        "session_id": session_id,
        "messages": [{"role": "user", "content": token}],
    }), encoding="utf-8")
    return request_dump, emergency_archive


def test_retention_and_explicit_delete_remove_only_owned_session_artifacts(tmp_path):
    home = tmp_path / ".hermes"
    sessions_dir = home / "sessions"
    db = SessionDB(db_path=home / "state.db")
    stale_id, live_id, neighbour_id = "stale", "live", "neighbour"
    for session_id in (stale_id, live_id, neighbour_id):
        db.create_session(session_id, source="cli")
        db.end_session(session_id, end_reason="done")

    stale_artifacts = _write_artifacts(home, stale_id, "stale")
    live_artifacts = _write_artifacts(home, live_id, "live")
    neighbour_artifacts = _write_artifacts(home, neighbour_id, "neighbour")
    old = time.time() - 10 * 86400
    db._execute_write(lambda conn: conn.execute(
        "UPDATE sessions SET started_at = ?, ended_at = ?, last_activity_at = ? WHERE id = ?",
        (old, old, old, stale_id),
    ))

    assert db.prune_sessions(older_than_days=1, sessions_dir=sessions_dir) == 1
    assert not any(path.exists() for path in stale_artifacts)
    assert all(path.exists() for path in live_artifacts + neighbour_artifacts)

    assert db.delete_session(live_id, sessions_dir=sessions_dir)
    assert not any(path.exists() for path in live_artifacts)
    assert all(path.exists() for path in neighbour_artifacts)
    assert db.get_session(neighbour_id) is not None
    db.close()
