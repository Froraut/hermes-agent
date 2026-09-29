"""Effort pickers and /reasoning report the actual harness or inference request vocabulary."""
from agent.reasoning_effort import effort_display_label


def test_ultra_label_distinguishes_native_codex_from_direct_responses():
    assert effort_display_label("ultra", "openai-codex", "gpt-6-sol", "codex_app_server") == "ultra"
    assert effort_display_label("ultra", "openai-codex", "gpt-6-sol", "codex_responses") == "ultra (sends max on this route)"




def test_supported_level_label_is_the_level_itself():
    assert effort_display_label("max", "openai-codex", "gpt-5.6-sol") == "max"
    assert effort_display_label("high", None, None) == "high"
    assert effort_display_label("", None, None) == ""
