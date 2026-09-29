"""``turn.alive``: liveness for a running turn that has emitted nothing lately.

A foreground tool emits nothing between ``tool.start`` and ``tool.complete``, so a client watching a turn
cannot tell a quiet one from a dead one. The Desktop settled such turns as "the connection dropped" after
45 s (#122416, #125306) and now has to ask ``session.active_list`` every time a turn goes quiet. The
gateway knows: while a session's live status is ``working`` or ``starting`` (``server._session_live_status``,
the same answer ``session.active_list`` gives), this sends ``turn.alive`` once the session has had no event
for :data:`TURN_ALIVE_INTERVAL_S`. A live transport with no ``turn.alive`` then means the turn really stopped
emitting.

The frame is ephemeral: ``event_replay`` does not sequence or keep it, so it cannot push real events out of
a session's replay ring during a long tool call, and a reconnecting client never replays stale liveness.
"""

from __future__ import annotations

import logging
import threading
import time

from tui_gateway._env import env_float

logger = logging.getLogger(__name__)

EVENT = "turn.alive"
#: Quiet seconds before a running turn gets a frame; clients learn it from ``gateway.ready`` ``turn_alive_s``.
#: Well inside the Desktop's 45 s silence window, so one lost frame does not cost a status check.
#: ``HERMES_TURN_ALIVE_S=0`` turns the frames off (clients then fall back to asking ``session.active_list``).
TURN_ALIVE_INTERVAL_S = max(0.0, env_float("HERMES_TURN_ALIVE_S", 15.0))
_TICK_S = 5.0
_ACTIVITY_MAX_CHARS = 160
_RUNNING_STATUSES = frozenset({"working", "starting"})

_lock = threading.Lock()
# sid -> monotonic time of the last event frame emitted for it (or of the first tick that saw it running).
_last_emit: dict[str, float] = {}
_started = False


def note_emit(sid: str) -> None:
    """Record an event frame for ``sid`` (``server._emit`` calls this after every successful write)."""
    if sid:
        with _lock:
            _last_emit[sid] = time.monotonic()


def _activity(session: dict) -> dict:
    """The local agent's own last-activity label and its age; empty when the turn runs elsewhere."""
    agent = session.get("agent")
    desc = getattr(agent, "_last_activity_desc", None)
    stamped = getattr(agent, "_last_activity_ts", None)
    out: dict = {}
    if isinstance(desc, str) and desc.strip():
        out["activity"] = desc.strip()[:_ACTIVITY_MAX_CHARS]
    if isinstance(stamped, (int, float)) and not isinstance(stamped, bool) and stamped > 0:
        out["activity_age_s"] = round(max(0.0, time.time() - float(stamped)), 1)
    return out


def tick(now: float | None = None) -> int:
    """One pass: send ``turn.alive`` to every running session quiet for the interval. Returns frames sent."""
    from tui_gateway import server

    if TURN_ALIVE_INTERVAL_S <= 0:
        return 0
    now = time.monotonic() if now is None else now
    with server._sessions_lock:
        snapshot = [(sid, s) for sid, s in server._sessions.items()
                    if s.get("transport") is not None and not s.get("_finalized")]
    running: list[tuple[str, dict, str]] = []
    for sid, session in snapshot:
        try:
            status = server._session_live_status(sid, session)
        except Exception:
            logger.debug("turn.alive: live status failed for %s", sid, exc_info=True)
            continue
        if status in _RUNNING_STATUSES:
            running.append((sid, session, status))
    due: list[tuple[str, dict, str, float]] = []
    with _lock:
        running_ids = {sid for sid, _session, _status in running}
        # Forget sessions that stopped running or left: a later turn counts its quiet afresh.
        for stale in [sid for sid in _last_emit if sid not in running_ids]:
            _last_emit.pop(stale, None)
        for sid, session, status in running:
            # A turn first seen here counts its quiet from now, not from an event before it started.
            quiet = now - _last_emit.setdefault(sid, now)
            if quiet >= TURN_ALIVE_INTERVAL_S:
                due.append((sid, session, status, quiet))
    sent = 0
    for sid, session, status, quiet in due:
        payload = {"status": status, "quiet_s": round(quiet, 1), **_activity(session)}
        try:
            if server._emit("turn.alive", sid, payload):
                sent += 1
        except Exception:
            logger.debug("turn.alive emit failed for %s", sid, exc_info=True)
    return sent


def ensure_started() -> None:
    """Start the ticker once per process (WS server startup; idempotent)."""
    global _started
    if TURN_ALIVE_INTERVAL_S <= 0:
        return
    with _lock:
        if _started:
            return
        _started = True

    def _loop() -> None:
        while True:
            time.sleep(_TICK_S)
            try:
                tick()
            except Exception:
                logger.debug("turn.alive tick failed", exc_info=True)

    threading.Thread(target=_loop, name="hermes-turn-alive", daemon=True).start()
