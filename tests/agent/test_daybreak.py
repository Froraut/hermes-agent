"""Daybreak is an explicit subscription turn choice, separate from the model id."""

from types import SimpleNamespace

import pytest

from agent.daybreak import daybreak_requested, daybreak_turn, requested_program
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


def test_daybreak_alias_requires_its_program_even_without_an_explicit_toggle():
    with daybreak_turn(False, provider="openai-codex", api_mode="codex_app_server", model="gpt-daybreak-red-latest"):
        assert daybreak_requested() is True
        assert requested_program("gpt-daybreak-red-latest") == "daybreak_red"
    assert daybreak_requested() is False
    with daybreak_turn(None, provider="openai", api_mode="responses", model="gpt-daybreak-red-latest"):
        assert requested_program("gpt-daybreak-red-latest") is None


def test_daybreak_access_error_does_not_rotate_to_another_subscription_account(monkeypatch):
    from agent import turn_recovery
    from agent.error_classifier import FailoverReason

    monkeypatch.setattr(turn_recovery, "_recover_welcome_tier", lambda *_: False)
    monkeypatch.setattr(turn_recovery, "_is_codex_token_expired", lambda *_: False)
    monkeypatch.setattr(turn_recovery, "_refresh_credentials_after_401", lambda *_: False)
    monkeypatch.setattr(turn_recovery, "_recover_format_errors", lambda *_: False)
    agent = SimpleNamespace(
        _recover_with_credential_pool=lambda **_: pytest.fail("Daybreak turn must keep the selected account"),
    )
    classified = SimpleNamespace(reason=FailoverReason.format_error, billing_unverified=False)
    retry = SimpleNamespace(has_retried_429=False)

    with daybreak_turn(True, provider="openai-codex", api_mode="codex_responses"):
        recovered = turn_recovery.recover_after_classification(
            agent, ValueError("invalid_access_program"), classified, retry,
            status_code=400, error_context={}, messages=[], api_messages=[],
        )
    assert recovered == (False, False)
