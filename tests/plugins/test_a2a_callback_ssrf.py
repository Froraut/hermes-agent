"""A2A push callbacks must not reach internal addresses by another spelling (#126755).

``is_safe_callback_url`` used to trust the hostname text. Integer and hex IPv4
literals, and names that resolve to a metadata address, were allowed. The POST
also followed redirects, so a public URL could bounce onto those targets.
"""

import socket
import urllib.error
import urllib.request

import pytest

from plugins.platforms.a2a import security


def test_integer_and_hex_ipv4_literals_are_internal(monkeypatch):
    monkeypatch.setenv("A2A_BEARER_TOKEN", "tok")
    assert security.is_safe_callback_url("http://2852039166/latest/meta-data/") is False
    assert security.is_safe_callback_url("http://0x7f000001/") is False
    assert security.is_safe_callback_url("http://0177.0.0.1/") is False
    # A public literal must stay allowed, or every dotted host looks internal.
    assert security.is_safe_callback_url("http://8.8.8.8/hook") is True


def test_dns_name_that_resolves_to_metadata_is_blocked(monkeypatch):
    monkeypatch.setenv("A2A_BEARER_TOKEN", "tok")

    def fake_getaddrinfo(host, port, *args, **kwargs):
        assert host == "metadata.invalid"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    assert security.is_safe_callback_url("http://metadata.invalid/latest/meta-data/") is False


def test_redirect_onto_metadata_is_refused(monkeypatch):
    monkeypatch.setenv("A2A_BEARER_TOKEN", "tok")
    opener = security.callback_opener(localhost_mode=False)
    handler = next(h for h in opener.handlers if isinstance(h, urllib.request.HTTPRedirectHandler))
    req = urllib.request.Request("https://example.com/cb", method="POST")
    with pytest.raises(urllib.error.HTTPError):
        handler.redirect_request(
            req, None, 302, "Found", {}, "http://169.254.169.254/latest/meta-data/")
