"""Runtime-environment gates survive disk skill-index snapshot reuse.

An ``environments:`` tag is an offer-time relevance gate: the verdict must come
from the runtime, not from whichever process first wrote the disk snapshot.
"""

from agent import skill_utils


def _setup(tmp_path, monkeypatch):
    from agent import prompt_builder as pb

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(pb, "get_disabled_skill_names", lambda *_: set())
    skills = tmp_path / "skills"
    for name, extra in (("s6-guide", "environments: [s6]\n"), ("plain-guide", "")):
        skill = skills / "devops" / name / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text(f"---\nname: {name}\ndescription: {name} instructions.\n{extra}---\nBody.\n",
                         encoding="utf-8")
    active = {"s6": False}
    monkeypatch.setitem(skill_utils._ENV_DETECTORS, "s6", lambda: active["s6"])
    monkeypatch.setattr(skill_utils, "_ENV_DETECT_CACHE", {})
    pb.clear_skills_system_prompt_cache(clear_snapshot=True)
    return pb, skills, active


def test_snapshot_build_matches_cold_scan_for_environment_gated_skill(tmp_path, monkeypatch):
    pb, skills, active = _setup(tmp_path, monkeypatch)
    try:
        cold = pb._build_skills_system_prompt_inner(skills, [], None, None, None)
        assert pb._load_skills_snapshot(skills) is not None
        pb.clear_skills_system_prompt_cache()  # keep the disk snapshot, drop the in-process LRU
        from_snapshot = pb._build_skills_system_prompt_inner(skills, [], None, None, None)
        assert from_snapshot == cold
        assert ("s6-guide" in from_snapshot) is active["s6"]
        assert "plain-guide" in from_snapshot
    finally:
        pb.clear_skills_system_prompt_cache(clear_snapshot=True)


def test_environment_verdict_is_reevaluated_against_reused_snapshot(tmp_path, monkeypatch):
    pb, skills, active = _setup(tmp_path, monkeypatch)
    try:
        def build():
            skill_utils._ENV_DETECT_CACHE.clear()
            pb.clear_skills_system_prompt_cache()
            return pb._build_skills_system_prompt_inner(skills, [], None, None, None)

        assert "s6-guide" not in build()
        assert pb._load_skills_snapshot(skills) is not None
        active["s6"] = True
        assert "s6-guide: s6-guide instructions." in build()
        active["s6"] = False
        assert "s6-guide" not in build()
    finally:
        pb.clear_skills_system_prompt_cache(clear_snapshot=True)
