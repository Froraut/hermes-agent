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


@contextmanager
def daybreak_turn(enabled: bool | None, *, provider: str, api_mode: str) -> Iterator[None]:
    if enabled and (provider != "openai-codex" or api_mode not in {"codex_responses", "codex_app_server"}):
        raise ValueError("Daybreak requires a ChatGPT/Codex subscription model.")
    token = _daybreak_requested.set(enabled is True)
    try:
        yield
    finally:
        _daybreak_requested.reset(token)


def requested_program(model: str) -> str | None:
    """Responses wire value; OpenAI remains authoritative for access and model compatibility."""
    if not _daybreak_requested.get():
        return None
    slug = (model or "").strip().lower()
    if slug.startswith(("gpt-daybreak-red-", "gpt-5.6-cyber")):
        return "daybreak_red"
    return "daybreak_blue"


def requested_app_server_program(model: str) -> str | None:
    program = requested_program(model)
    return {"daybreak_blue": "daybreakBlue", "daybreak_red": "daybreakRed"}.get(program)
