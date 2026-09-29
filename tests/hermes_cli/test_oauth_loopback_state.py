"""Loopback OAuth logins reject a non-ASCII callback ``state`` through their ordinary mismatch error.

``hmac.compare_digest`` raises TypeError when a str argument holds a non-ASCII character, and the
loopback listener's ``parse_qs`` decodes a percent-encoded UTF-8 ``state`` into exactly that. Drives
the real listener; only the system browser is replaced by an HTTP client sending a forged redirect.
"""

from __future__ import annotations

import threading
import urllib.request
from urllib.parse import parse_qs, urlencode, urlparse

import pytest

from hermes_cli.auth_constants import AuthError


def _codex_login(monkeypatch):
    from hermes_cli import auth_codex_browser as browser_mod

    monkeypatch.setattr(browser_mod, "CODEX_BROWSER_CALLBACK_PORT", 0)  # ephemeral; production is 1455
    monkeypatch.setattr(browser_mod, "_can_open_graphical_browser", lambda: True)
    return lambda: browser_mod._codex_browser_login(timeout_seconds=10), "codex_browser_state_mismatch"


def _pkce_plugin_login(monkeypatch):
    from hermes_cli import auth_oauth_pkce_plugin as pkce

    monkeypatch.setattr("hermes_cli.auth_device_flow._can_open_graphical_browser", lambda: True)
    cfg = pkce.OAuthPKCEConfig(client_id="hermes-example", authorize_url="https://idp.example/authorize",
                               token_url="https://idp.example/token", timeout_seconds=10)
    return lambda: pkce.login("example-pkce", cfg), "oauth_state_mismatch"


@pytest.mark.parametrize("login", [_codex_login, _pkce_plugin_login], ids=["openai-codex", "oauth-pkce-plugin"])
def test_non_ascii_callback_state_is_a_state_mismatch(monkeypatch, login):
    run, mismatch_code = login(monkeypatch)

    def _forged_redirect(url):
        redirect_uri = parse_qs(urlparse(url).query)["redirect_uri"][0]
        forged = f"{redirect_uri}?{urlencode({'code': 'AC-1', 'state': 'état-forgé'})}"
        threading.Thread(target=lambda: urllib.request.urlopen(forged, timeout=5).read(), daemon=True).start()
        return True
    monkeypatch.setattr("webbrowser.open", _forged_redirect)

    with pytest.raises(AuthError) as excinfo:
        run()
    assert excinfo.value.code == mismatch_code
