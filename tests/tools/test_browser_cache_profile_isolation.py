"""Browser session caches stay isolated by the owning Hermes profile.

Regression for #110032.  The process-global cache must let two homes use the
same task id concurrently; switching A -> B -> A must recover A's original
session rather than hand either profile the other's browser.
"""

from contextlib import contextmanager

import pytest

from hermes_constants import reset_hermes_home_override, set_hermes_home_override

import tools.browser_tool as bt
from tools import browser_tool_cdp as bt_cdp
from tools import browser_tool_lifecycle as bt_lifecycle
from tools import browser_tool_session as bt_session


@pytest.fixture(autouse=True)
def _reset_browser_caches():
    for cache in (
        bt._active_sessions,
        bt._session_last_activity,
        bt._last_active_session_key,
        bt._suspect_browser_sessions,
        bt._recording_sessions,
        bt._cleanup_failures,
    ):
        cache.clear()
    yield
    for cache in (
        bt._active_sessions,
        bt._session_last_activity,
        bt._last_active_session_key,
        bt._suspect_browser_sessions,
        bt._recording_sessions,
        bt._cleanup_failures,
    ):
        cache.clear()


@contextmanager
def _under(home):
    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def test_browser_session_survives_two_home_a_b_a_round_trip(tmp_path, monkeypatch):
    home_a, home_b = tmp_path / "profile-a", tmp_path / "profile-b"
    home_a.mkdir()
    home_b.mkdir()
    created_for = []

    def create(task_id, force_local):
        owner = str(home_a if len(created_for) == 0 else home_b)
        created_for.append(owner)
        return {"session_name": owner, "bb_session_id": None, "features": {}}

    monkeypatch.setattr(bt_session, "_create_session_for_key", create)
    monkeypatch.setattr(bt_lifecycle, "_start_browser_cleanup_thread", lambda: None)
    monkeypatch.setattr(bt_cdp, "_ensure_cdp_supervisor", lambda _task_id: None)

    with _under(home_a):
        session_a = bt_session._get_session_info("shared")
    with _under(home_b):
        session_b = bt_session._get_session_info("shared")
    with _under(home_a):
        session_a_again = bt_session._get_session_info("shared")

    assert session_a["session_name"] == str(home_a)
    assert session_b["session_name"] == str(home_b)
    assert session_a_again is session_a
    assert len(bt._active_sessions) == 2
