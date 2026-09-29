"""A2A bearer auth treats a non-ASCII presented token as an ordinary wrong token.

``hmac.compare_digest`` raises TypeError on a non-ASCII ``str``. The Authorization header is
remote input, so ``authenticate`` must reject it like any unknown token (401) instead of raising,
which kills the HTTP handler thread and drops the connection without a response.
"""

import pytest

from plugins.platforms.a2a import security


@pytest.mark.parametrize(
    "env", [{"A2A_PEER_TOKENS": "alice:tok-a"}, {"A2A_BEARER_TOKEN": "shared-tok"}],
    ids=["peer_tokens", "shared_bearer"])
def test_non_ascii_bearer_is_rejected_like_unknown_token(monkeypatch, env):
    for name in ("A2A_PEER_TOKENS", "A2A_BEARER_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    ctx = security.A2ASecurityContext.capture()

    unknown = ctx.authenticate("Bearer unknown", "1.2.3.4")
    assert unknown is None  # a token is configured, so the gate is closed
    assert ctx.authenticate("Bearer tökén", "1.2.3.4") == unknown
