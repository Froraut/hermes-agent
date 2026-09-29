"""Daybreak is an explicit subscription turn choice, separate from the model id."""

import pytest

from agent.daybreak import daybreak_turn, requested_program
from agent.transports.codex import ResponsesApiTransport


def test_chatgpt_subscription_request_carries_daybreak_without_changing_other_routes():
    transport = ResponsesApiTransport()
    messages = [{"role": "user", "content": "check this patch"}]
    overrides = {"extra_body": {"metadata": {"source": "test"}}}

    with daybreak_turn(True, provider="openai-codex", api_mode="codex_responses"):
        blue = transport.build_kwargs(
            "gpt-6-sol", messages, is_codex_backend=True,
            request_overrides=overrides, cyber_access_program=requested_program("gpt-6-sol"),
        )
        red = transport.build_kwargs(
            "gpt-daybreak-red-latest", messages, is_codex_backend=True,
            cyber_access_program=requested_program("gpt-daybreak-red-latest"),
        )
    assert blue["extra_body"] == {"metadata": {"source": "test"}, "access_programs": {"cyber": "daybreak_blue"}}
    assert red["extra_body"]["access_programs"] == {"cyber": "daybreak_red"}

    with daybreak_turn(False, provider="openai-codex", api_mode="codex_responses"):
        ordinary = transport.build_kwargs(
            "gpt-6-sol", messages, is_codex_backend=True,
            cyber_access_program=requested_program("gpt-6-sol"),
        )
    assert "access_programs" not in ordinary.get("extra_body", {})

    other_route = transport.build_kwargs(
        "gpt-6-sol", messages, is_codex_backend=False, cyber_access_program="daybreak_blue",
    )
    assert "access_programs" not in other_route.get("extra_body", {})


def test_daybreak_rejects_non_subscription_runtime_before_a_model_call():
    with pytest.raises(ValueError, match="ChatGPT/Codex subscription"):
        with daybreak_turn(True, provider="openai", api_mode="codex_responses"):
            pass
    assert requested_program("gpt-6-sol") is None
