"""``agent.daybreak`` — the profile default for turns that carry no explicit Daybreak choice.

Read through the TUI gateway's own loader (``_load_cfg``) from a temp ``config.yaml``, the same
path ``prompt_turn`` uses before entering ``daybreak_turn``.
"""

import pytest

from agent import daybreak
from tui_gateway import server


@pytest.fixture
def daybreak_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes-home"
    home.mkdir()
    (home / "config.yaml").write_text("agent:\n  daybreak: true\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(server, "_hermes_home", home)
    from agent import model_metadata
    monkeypatch.setattr(model_metadata, "codex_access_programs", lambda *_: {
        "gpt-6-sol": ["standard", "daybreak_blue"], "gpt-6-astra": ["standard"]})
    return home


def test_profile_default_requests_daybreak_only_where_the_catalog_allows_it(daybreak_home):
    cfg = server._load_cfg()
    route = {"provider": "openai-codex", "api_mode": "codex_responses", "access_token": "t"}
    assert daybreak.resolve_turn_daybreak(None, cfg, model="gpt-6-sol-900k", **route) is True
    # Ineligible model, app-server runtime (keeps Codex defaults, #75186), API-key route: no request.
    assert daybreak.resolve_turn_daybreak(None, cfg, model="gpt-6-astra", **route) is None
    assert daybreak.resolve_turn_daybreak(
        None, cfg, model="gpt-6-sol", provider="openai-codex", api_mode="codex_app_server") is None
    assert daybreak.resolve_turn_daybreak(
        None, cfg, model="gpt-6-sol", provider="openai", api_mode="codex_responses") is None


def test_explicit_choice_wins_and_the_default_is_off(daybreak_home):
    route = {"provider": "openai-codex", "api_mode": "codex_responses", "access_token": "t", "model": "gpt-6-sol"}
    assert daybreak.resolve_turn_daybreak(False, server._load_cfg(), **route) is False
    assert daybreak.resolve_turn_daybreak(None, {}, **route) is None
    assert daybreak.resolve_turn_daybreak(None, {"agent": {"daybreak": False}}, **route) is None
