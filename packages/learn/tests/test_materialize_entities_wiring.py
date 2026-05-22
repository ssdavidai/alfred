"""F36 (wiring) — materialize_matter_entities is registered on the worker
and runs as a post-pack stage in the onboarding pipeline.
"""
from __future__ import annotations

import inspect


def test_activity_registered_on_worker():
    from src.activities.packs_opus import materialize_matter_entities
    from src.worker import ALL_ACTIVITIES
    assert materialize_matter_entities in ALL_ACTIVITIES


def test_pipeline_runs_the_stage_after_packs():
    import src.workflows.onboarding_pipeline as pipeline
    src = inspect.getsource(pipeline)
    # The pipeline imports and executes the activity.
    assert "materialize_matter_entities" in src
    # It runs after the stream pack (the last packs-stage write).
    assert src.index("generate_stream_pack") < src.index(
        "materialize_matter_entities,\n                    args=[onboard_path]"
    )
