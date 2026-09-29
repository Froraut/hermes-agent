"""``turn.alive``: liveness frames for a running turn that has emitted nothing lately."""

import time

import pytest

from tui_gateway import event_replay, server, turn_alive


class _Transport:
    def __init__(self):
        self.frames = []

    def write(self, obj):
        self.frames.append(obj)
        return True

    def alive(self):
        return [f["params"] for f in self.frames if f.get("params", {}).get("type") == turn_alive.EVENT]


class _Agent:
    _last_activity_desc = "waiting for stream response (60s, prefill)"

    def __init__(self, age_s):
        self._last_activity_ts = time.time() - age_s


@pytest.fixture
def sessions(monkeypatch):
    live: dict[str, dict] = {}
    monkeypatch.setattr(server, "_sessions", live)
    monkeypatch.setattr(server, "_session_pending_kind", lambda sid: "")
    monkeypatch.setattr(turn_alive, "_last_emit", {})
    event_replay.reset_replay_state()
    yield live
    event_replay.reset_replay_state()


def _session(running=True, **extra):
    return {"transport": _Transport(), "running": running, **extra}


def test_quiet_running_turn_gets_one_frame_per_interval(sessions):
    sessions["s1"] = _session()
    t0 = 1000.0

    assert turn_alive.tick(t0) == 0  # first sight starts the quiet clock
    assert turn_alive.tick(t0 + turn_alive.TURN_ALIVE_INTERVAL_S - 0.1) == 0
    assert turn_alive.tick(t0 + turn_alive.TURN_ALIVE_INTERVAL_S) == 1

    (params,) = sessions["s1"]["transport"].alive()
    assert params["session_id"] == "s1"
    assert params["payload"]["status"] == "working"
    assert params["payload"]["quiet_s"] == turn_alive.TURN_ALIVE_INTERVAL_S


def test_the_frame_itself_restarts_the_quiet_clock(sessions, monkeypatch):
    sessions["s1"] = _session()
    clock = [2000.0]
    monkeypatch.setattr(turn_alive.time, "monotonic", lambda: clock[0])

    turn_alive.tick()
    clock[0] += turn_alive.TURN_ALIVE_INTERVAL_S
    assert turn_alive.tick() == 1
    clock[0] += turn_alive.TURN_ALIVE_INTERVAL_S - 1
    assert turn_alive.tick() == 0
    clock[0] += 1
    assert turn_alive.tick() == 1


def test_any_other_event_for_the_session_defers_it(sessions, monkeypatch):
    sessions["s1"] = _session()
    clock = [3000.0]
    monkeypatch.setattr(turn_alive.time, "monotonic", lambda: clock[0])

    turn_alive.tick()
    clock[0] += turn_alive.TURN_ALIVE_INTERVAL_S - 1
    assert server._emit("message.start", "s1") is True
    clock[0] += 1
    assert turn_alive.tick() == 0
    assert sessions["s1"]["transport"].alive() == []


def test_idle_waiting_detached_and_finalized_sessions_get_nothing(sessions, monkeypatch):
    sessions["idle"] = _session(running=False)
    sessions["waiting"] = _session()
    sessions["detached"] = {"transport": None, "running": True}
    sessions["finalized"] = _session(_finalized=True)
    monkeypatch.setattr(server, "_session_pending_kind", lambda sid: "approval.request" if sid == "waiting" else "")

    turn_alive.tick(0.0)

    assert turn_alive.tick(turn_alive.TURN_ALIVE_INTERVAL_S * 4) == 0


def test_an_agent_build_counts_as_running(sessions):
    class _NotReady:
        def is_set(self):
            return False

    sessions["s1"] = _session(running=False, agent_ready=_NotReady(), agent_build_started=True)

    turn_alive.tick(0.0)
    assert turn_alive.tick(turn_alive.TURN_ALIVE_INTERVAL_S) == 1
    assert sessions["s1"]["transport"].alive()[0]["payload"]["status"] == "starting"


def test_carries_the_local_agents_activity(sessions):
    sessions["s1"] = _session(agent=_Agent(age_s=42))

    turn_alive.tick(0.0)
    turn_alive.tick(turn_alive.TURN_ALIVE_INTERVAL_S)

    payload = sessions["s1"]["transport"].alive()[0]["payload"]
    assert payload["activity"] == "waiting for stream response (60s, prefill)"
    assert 41 <= payload["activity_age_s"] <= 44


def test_frames_are_not_sequenced_or_kept_for_replay(sessions, monkeypatch):
    sessions["s1"] = _session()
    clock = [5000.0]
    monkeypatch.setattr(turn_alive.time, "monotonic", lambda: clock[0])
    server._emit("message.start", "s1")

    for _ in range(39):  # a ten-minute quiet tool call
        clock[0] += turn_alive.TURN_ALIVE_INTERVAL_S
        turn_alive.tick()

    alive = sessions["s1"]["transport"].alive()
    assert len(alive) == 39
    assert all("seq" not in params for params in alive)
    assert event_replay.latest_seq("s1") == 1
    assert [e["type"] for e in event_replay.events_since("s1", 0)] == ["message.start"]


def test_a_later_turn_counts_its_quiet_afresh(sessions):
    sessions["s1"] = _session()
    turn_alive.tick(0.0)

    sessions["s1"]["running"] = False
    turn_alive.tick(100.0)
    sessions["s1"]["running"] = True

    assert turn_alive.tick(200.0) == 0  # first sight of the new turn
    assert turn_alive.tick(200.0 + turn_alive.TURN_ALIVE_INTERVAL_S) == 1


def test_payload_matches_the_contract(sessions, monkeypatch):
    from tui_gateway.contracts import registry

    monkeypatch.setattr(registry, "STRICT", True)
    sessions["s1"] = _session(agent=_Agent(age_s=5))

    turn_alive.tick(0.0)
    assert turn_alive.tick(turn_alive.TURN_ALIVE_INTERVAL_S) == 1
