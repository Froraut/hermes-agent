from gateway.interaction_owner import InteractionOwner


def test_interaction_owner_rejects_every_foreign_or_stale_anchor():
    owner = InteractionOwner.capture(
        "channel-1",
        {
            "user_id": "actor-1",
            "channel_id": "channel-1",
            "thread_id": "thread-1",
            "message_id": "source-1",
            "hermes_profile": "work",
        },
        generation="generation-1",
    ).bind_prompt("prompt-1")

    valid = dict(
        actor_id="actor-1", chat_id="channel-1", channel_id="channel-1",
        thread_id="thread-1", prompt_message_id="prompt-1", generation="generation-1",
    )
    assert owner.accepts(**valid)
    for field, foreign in {
        "actor_id": "actor-2", "chat_id": "channel-2", "channel_id": "channel-2",
        "thread_id": "thread-2", "prompt_message_id": "prompt-2", "generation": "generation-2",
    }.items():
        attempt = {**valid, field: foreign}
        assert not owner.accepts(**attempt), field

    assert owner.source_message_id == "source-1"
    assert owner.profile == "work"
