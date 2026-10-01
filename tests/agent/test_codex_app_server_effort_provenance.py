"""Codex app-server keeps its own configured effort unless the user explicitly picked one (#75186)."""
from types import SimpleNamespace

import pytest

from agent.codex_runtime import _explicit_codex_effort


@pytest.mark.parametrize("explicit,config,expected", [
    (False, {"enabled": True, "effort": "high"}, None),  # profile default: omitted
    (True, {"enabled": True, "effort": "ultra"}, "ultra"),
    (True, {"enabled": True, "effort": "high"}, "high"),
    (True, {"enabled": False}, "none"),
    (True, None, None),
])
def test_only_an_explicit_pick_reaches_turn_start(explicit, config, expected):
    agent = SimpleNamespace(reasoning_config=config, _reasoning_pick_explicit=explicit)
    assert _explicit_codex_effort(agent) == expected

