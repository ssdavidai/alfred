"""Unit tests for OBS-4 pattern_detection.

The activity has three layers:

1. ``_build_clusters`` — pure function over observation records.
   This is what's exhaustively covered here.
2. ``_fetch_skip_set`` — HTTP, exercised in the end-to-end smoke
   on david rather than here.
3. ``_build_proposal`` — payload shaping; covered with one
   round-trip through the validator.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from src.activities.pattern_detection import (
    INTENT_AGREEMENT,
    MIN_CLUSTER_SIZE,
    WINDOW_DAYS,
    _build_clusters,
    _build_proposal,
    _normalise_sender_key,
)
from src.validators.pattern_proposal import validate_pattern_proposal_record


def _now_iso(offset_days: int = 0) -> str:
    return (
        datetime.now(timezone.utc) - timedelta(days=offset_days)
    ).isoformat()


def _obs(
    *,
    path: str,
    sender: str,
    intent: str,
    subject: str = "principal",
    source_kind: str = "decision",
    offset_days: int = 1,
    topic: str = "test/topic",
    matter_ref: str = "",
) -> dict[str, Any]:
    """Build an observation list-result entry."""
    return {
        "path": path,
        "frontmatter": {
            "type": "observation",
            "subject": subject,
            "source_kind": source_kind,
            "sender": sender,
            "intent": intent,
            "topic": topic,
            "matter_ref": matter_ref,
            "created": _now_iso(offset_days),
        },
    }


# ---------------------------------------------------------------------------
# _build_clusters
# ---------------------------------------------------------------------------

def test_homogeneous_sender_above_threshold_clusters() -> None:
    obs = [
        _obs(path=f"observation/a-{i}.md", sender="org/AcmeNewsletter", intent="noise")
        for i in range(MIN_CLUSTER_SIZE)
    ]
    clusters = _build_clusters(obs, window_days=WINDOW_DAYS)
    assert len(clusters) == 1
    c = clusters[0]
    assert c["sender"] == "org/AcmeNewsletter"
    assert c["intent"] == "noise"
    assert c["cluster_size"] == MIN_CLUSTER_SIZE
    assert c["agreement"] == 1.0


def test_below_threshold_size_drops_cluster() -> None:
    obs = [
        _obs(path=f"observation/a-{i}.md", sender="org/Acme", intent="noise")
        for i in range(MIN_CLUSTER_SIZE - 1)
    ]
    assert _build_clusters(obs, window_days=WINDOW_DAYS) == []


def test_mixed_intent_below_agreement_drops_cluster() -> None:
    # 5 noise + 5 delegate from same sender — 50/50 split, neither
    # dominant intent above 80% agreement.
    obs = [
        _obs(path=f"observation/n-{i}.md", sender="org/Mix", intent="noise")
        for i in range(5)
    ] + [
        _obs(path=f"observation/d-{i}.md", sender="org/Mix", intent="delegate")
        for i in range(5)
    ]
    assert _build_clusters(obs, window_days=WINDOW_DAYS) == []


def test_mixed_intent_above_agreement_proposes_dominant() -> None:
    # 8 noise + 2 delegate = 80% noise agreement (== threshold; the
    # check is >= INTENT_AGREEMENT so this should pass).
    obs = [
        _obs(path=f"observation/n-{i}.md", sender="org/Dom", intent="noise")
        for i in range(8)
    ] + [
        _obs(path=f"observation/d-{i}.md", sender="org/Dom", intent="delegate")
        for i in range(2)
    ]
    clusters = _build_clusters(obs, window_days=WINDOW_DAYS)
    assert len(clusters) == 1
    c = clusters[0]
    assert c["intent"] == "noise"
    assert c["cluster_size"] == 8
    assert c["total_in_bucket"] == 10
    assert c["agreement"] == 0.8


def test_principal_via_alfred_subject_excluded() -> None:
    # Autonomous Alfred fires must NOT count as principal preference.
    obs = [
        _obs(
            path=f"observation/a-{i}.md",
            sender="org/Acme",
            intent="noise",
            subject="principal_via_alfred",
        )
        for i in range(MIN_CLUSTER_SIZE * 2)
    ]
    assert _build_clusters(obs, window_days=WINDOW_DAYS) == []


def test_signal_source_kind_excluded() -> None:
    # Signal observations carry intent=null and don't tell us what
    # the principal *did*. Even with a non-null intent (defensively),
    # source_kind=signal must not feed into the decision cluster.
    obs = [
        _obs(
            path=f"observation/s-{i}.md",
            sender="org/Acme",
            intent="noise",
            source_kind="signal",
        )
        for i in range(MIN_CLUSTER_SIZE * 2)
    ]
    assert _build_clusters(obs, window_days=WINDOW_DAYS) == []


def test_observations_outside_window_excluded() -> None:
    # All observations are 60 days old, outside the 30-day window.
    obs = [
        _obs(
            path=f"observation/old-{i}.md",
            sender="org/Acme",
            intent="noise",
            offset_days=60,
        )
        for i in range(MIN_CLUSTER_SIZE * 2)
    ]
    assert _build_clusters(obs, window_days=WINDOW_DAYS) == []


def test_unrouted_intent_skipped() -> None:
    # take_mine is a routable category in the decision model but the
    # detector explicitly excludes it from auto-route proposals — it's
    # the negative-space signal "I'll do this myself, don't automate".
    obs = [
        _obs(path=f"observation/t-{i}.md", sender="org/Acme", intent="take_mine")
        for i in range(MIN_CLUSTER_SIZE * 2)
    ]
    assert _build_clusters(obs, window_days=WINDOW_DAYS) == []


def test_two_senders_produce_two_clusters() -> None:
    obs = (
        [
            _obs(path=f"observation/a-{i}.md", sender="org/Acme", intent="noise")
            for i in range(MIN_CLUSTER_SIZE)
        ]
        + [
            _obs(path=f"observation/b-{i}.md", sender="org/Beta", intent="delegate")
            for i in range(MIN_CLUSTER_SIZE)
        ]
    )
    clusters = _build_clusters(obs, window_days=WINDOW_DAYS)
    senders = {c["sender"] for c in clusters}
    assert senders == {"org/Acme", "org/Beta"}


def test_strongest_cluster_first() -> None:
    obs = (
        # weaker: agreement 1.0 but cluster_size 5
        [
            _obs(path=f"observation/w-{i}.md", sender="org/Weak", intent="noise")
            for i in range(MIN_CLUSTER_SIZE)
        ]
        # stronger: agreement 1.0 and cluster_size 20
        + [
            _obs(path=f"observation/s-{i}.md", sender="org/Strong", intent="delegate")
            for i in range(20)
        ]
    )
    clusters = _build_clusters(obs, window_days=WINDOW_DAYS)
    assert clusters[0]["sender"] == "org/Strong"


def test_missing_sender_or_intent_skipped() -> None:
    obs = [
        _obs(path=f"observation/x-{i}.md", sender="", intent="noise")
        for i in range(MIN_CLUSTER_SIZE)
    ] + [
        _obs(path=f"observation/y-{i}.md", sender="org/Y", intent="")
        for i in range(MIN_CLUSTER_SIZE)
    ]
    assert _build_clusters(obs, window_days=WINDOW_DAYS) == []


# ---------------------------------------------------------------------------
# _build_proposal — payload round-trip
# ---------------------------------------------------------------------------

def test_proposal_payload_passes_validator() -> None:
    cluster = {
        "sender": "org/AcmeNewsletter",
        "intent": "noise",
        "cluster_size": 12,
        "total_in_bucket": 14,
        "agreement": 0.857,
        "observation_refs": [
            f"observation/a-{i}.md" for i in range(10)
        ],
        "topics": ["newsletter/marketing"],
        "matter_refs": [],
    }
    record_name, content, fm = _build_proposal(cluster, now_iso=_now_iso(0))
    # The frontmatter dict is exactly what the validator inspects.
    result = validate_pattern_proposal_record(fm)
    assert result.valid, result.errors

    # Sanity: the rendered content carries the rule sentence and the
    # principal's verb so a reader of /vault/pattern_proposal can
    # understand it cold.
    assert "AcmeNewsletter" in content
    assert "noise" in content.lower()
    # The display label lives on fm["name"]; record_name is the slug
    # used for the .md filename and is deterministic on sender+intent.
    assert "Auto-noise" in fm["name"]
    assert record_name and record_name.endswith("Z-" + record_name.split("-")[-1])


# ---------------------------------------------------------------------------
# _normalise_sender_key
# ---------------------------------------------------------------------------

def test_normalise_sender_key_strips_namespace_and_case() -> None:
    assert _normalise_sender_key("org/Acme") == "acme"
    assert _normalise_sender_key("person/Alice Brown") == "alice brown"
    assert _normalise_sender_key("ALICE@FOO.COM") == "alice@foo.com"
    assert _normalise_sender_key("") == ""
    assert _normalise_sender_key(None) == ""  # type: ignore[arg-type]


def test_normalise_sender_key_idempotent() -> None:
    k1 = _normalise_sender_key("org/Acme")
    k2 = _normalise_sender_key(k1)
    assert k1 == k2


# ---------------------------------------------------------------------------
# INTENT_AGREEMENT sanity (locked at 0.8 unless OBS-7 retunes)
# ---------------------------------------------------------------------------

def test_threshold_constants_are_conservative() -> None:
    # If somebody bumps these without updating the tests above, the
    # cluster-size math in _build_clusters needs revisiting. Keep
    # this assertion as a tripwire.
    assert MIN_CLUSTER_SIZE >= 3
    assert 0.5 < INTENT_AGREEMENT <= 1.0
    assert WINDOW_DAYS >= 7
