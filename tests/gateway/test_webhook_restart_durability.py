"""Restart durability contract for accepted webhook deliveries."""

import hashlib
import hmac
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.webhook import WebhookAdapter, _WebhookDeliveryIdentity


@pytest.mark.asyncio
async def test_restart_preserves_idempotency_and_delivery_envelope(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    secret = "fake-signing-secret"
    route = {
        "secret": secret,
        "deliver": "telegram",
        "deliver_extra": {"chat_id": "fake-chat"},
        "prompt": "Alert: {message}",
    }
    config = PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "routes": {"alerts": route}})
    body = json.dumps({"message": "fake payload"}).encode()
    headers = {
        "Content-Type": "application/json",
        "X-GitHub-Delivery": "fake-delivery-1",
        "X-Hub-Signature-256": "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest(),
    }

    first = WebhookAdapter(config)
    received = []

    async def capture(event):
        received.append(event)

    first.handle_message = capture
    app = web.Application()
    app.router.add_post("/webhooks/{route_name}", first._handle_webhook)
    async with TestClient(TestServer(app)) as client:
        response = await client.post("/webhooks/alerts", data=body, headers=headers)
        assert response.status == 202

    restarted = WebhookAdapter(config)
    restarted.handle_message = capture
    app = web.Application()
    app.router.add_post("/webhooks/{route_name}", restarted._handle_webhook)
    async with TestClient(TestServer(app)) as client:
        response = await client.post("/webhooks/alerts", data=body, headers=headers)
        assert response.status == 200
        assert (await response.json())["status"] == "duplicate"

    assert len(received) == 1
    identity = _WebhookDeliveryIdentity.from_parts(None, "alerts", "fake-delivery-1")
    assert identity in restarted._seen_deliveries
    envelope = restarted._delivery_info[identity.session_chat_id]
    assert envelope["deliver"] == "telegram"
    assert envelope["deliver_extra"] == {"chat_id": "fake-chat"}
