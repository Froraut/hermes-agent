"""Per-turn Daybreak selection for ChatGPT/Codex subscription requests.

The model slug and access program are independent. Keep the user's choice in a
ContextVar so it follows one Hermes turn (including tool follow-ups) without
leaking into another session.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator


_daybreak_requested: ContextVar[bool] = ContextVar("hermes_daybreak_requested", default=False)


def daybreak_requested() -> bool:
    """Whether this turn requires Daybreak treatment."""
    return _daybreak_requested.get()


@contextmanager
def daybreak_turn(enabled: bool | None, *, provider: str, api_mode: str, model: str = "") -> Iterator[None]:
    subscription = provider == "openai-codex" and api_mode in {"codex_responses", "codex_app_server"}
    if enabled and not subscription:
        raise ValueError("Daybreak requires a ChatGPT/Codex subscription model.")
    # These model ids cannot run with standard treatment. Make their implicit
    # requirement explicit so transport selection and fallback use the same rule.
    required_by_model = subscription and (model or "").strip().lower().startswith(
        ("gpt-daybreak-blue-", "gpt-daybreak-red-", "gpt-5.6-cyber")
    )
    token = _daybreak_requested.set(enabled is True or required_by_model)
    try:
        yield
    finally:
        _daybreak_requested.reset(token)


def requested_program(model: str) -> str | None:
    """Responses wire value; OpenAI remains authoritative for access and model compatibility."""
    if not daybreak_requested():
        return None
    slug = (model or "").strip().lower()
    if slug.startswith(("gpt-daybreak-red-", "gpt-5.6-cyber")):
        return "daybreak_red"
    return "daybreak_blue"


def requested_app_server_program(model: str) -> str | None:
    program = requested_program(model)
    return {"daybreak_blue": "daybreakBlue", "daybreak_red": "daybreakRed"}.get(program)
