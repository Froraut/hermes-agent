"""A child spawned FOR another profile never inherits the launch profile's ``TERMINAL_*`` policy.

``strip_launch_profile_env`` dropped a ``TERMINAL_*`` name only when it appeared in the launch ``.env`` or
in ``TERMINAL_CONFIG_ENV_MAP``. A key the launch process got from systemd ``Environment=`` / ``op run``
(``TERMINAL_LOCAL_MEMORY_MAX_MB``) or from a bridge output outside that map (``TERMINAL_DOCKER_IMAGE_PINNED``)
crossed into ``hermes -p B``: B's worker ran under A's memory cap and read its default image as pinned, so
a default-image flip deleted B's persisted sandbox. A routed terminal scope never reads ambient
``TERMINAL_*``; a routed child must not either.
"""

import json
import os
import subprocess
import sys

import pytest

from hermes_cli.config import apply_terminal_config_to_env
from tools.environments.local import served_profile_child_env

_PROBE = ("import json,os;print(json.dumps({k:v for k,v in os.environ.items() "
          "if k.upper().startswith('TERMINAL_')}))")


def _terminal_env_seen_by_child(env: dict) -> dict:
    out = subprocess.run([sys.executable, "-c", _PROBE], env=env, capture_output=True,
                         text=True, encoding="utf-8", errors="replace", timeout=60)
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.fixture
def launch_env(tmp_path, monkeypatch):
    """Launch home A (the process's HERMES_HOME) pins a docker image in config.yaml; its ``.env`` holds
    no terminal setting. The memory cap arrives through the process env only (systemd ``Environment=``)."""
    a = tmp_path / ".hermes"
    b = a / "profiles" / "b"
    b.mkdir(parents=True)
    (a / ".env").write_text("A_MARKER=a\n", encoding="utf-8")
    (a / "config.yaml").write_text("terminal:\n  docker_image: a-image\n", encoding="utf-8")
    (b / ".env").write_text("B_MARKER=b\n", encoding="utf-8")
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(a))
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("TERMINAL_")}
    env["TERMINAL_LOCAL_MEMORY_MAX_MB"] = "64"
    apply_terminal_config_to_env(env=env)  # A's own startup bridge, as load_hermes_dotenv runs it
    return a, b, env


def test_routed_child_drops_env_only_and_bridged_terminal_policy_launch_child_keeps_it(launch_env):
    """A -> B -> A through the seam every served-profile spawn uses, observed from inside a real child."""
    a, b, env = launch_env
    launch_policy = {"TERMINAL_LOCAL_MEMORY_MAX_MB": "64", "TERMINAL_DOCKER_IMAGE_PINNED": "1"}
    assert launch_policy.items() <= env.items()

    assert launch_policy.items() <= _terminal_env_seen_by_child(
        served_profile_child_env(base=env, target_home=a)).items()
    assert _terminal_env_seen_by_child(served_profile_child_env(base=env, target_home=b)) == {}, (
        "B's child inherited the launch profile's terminal policy")
    assert launch_policy.items() <= _terminal_env_seen_by_child(
        served_profile_child_env(base=env, target_home=a)).items()
