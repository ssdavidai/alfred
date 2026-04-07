"""Predict sender engagement probability using BG/NBD model."""

from __future__ import annotations

import logging
import signal
from contextlib import contextmanager
from typing import Any

import numpy as np
import pandas as pd
from lifetimes import BetaGeoFitter

logger = logging.getLogger(__name__)

_MIN_SENDERS = 10
_MIN_TRANSACTIONS = 2
_FIT_TIMEOUT_SECONDS = 30
_DORMANT_DAYS = 30
_HIGH_VALUE_PERCENTILE = 80


def predict_engagement(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    """Predict per-sender engagement using BG/NBD (BetaGeoFitter).

    Returns {domain: {alive_probability, expected_contacts_30d, segment}}.

    Segments:
    - high_value: top 20% alive probability
    - at_risk: alive probability < 0.3
    - dormant: no email in 30+ days
    - regular: everything else

    Skips if <10 senders with 2+ emails. 30s timeout on model fitting.
    """
    if df.empty:
        return {}

    rfm = _compute_rfm(df)
    if rfm is None or len(rfm) < _MIN_SENDERS:
        logger.info(
            "Skipping engagement prediction: insufficient qualifying senders"
        )
        return {}

    # Fit BG/NBD model with timeout
    fitter = BetaGeoFitter(penalizer_coef=0.01)
    try:
        with _timeout(_FIT_TIMEOUT_SECONDS):
            fitter.fit(
                rfm["frequency"],
                rfm["recency"],
                rfm["T"],
            )
    except TimeoutError:
        logger.warning("BG/NBD fitting timed out after %ds", _FIT_TIMEOUT_SECONDS)
        return {}
    except Exception:
        logger.exception("BG/NBD fitting failed")
        return {}

    # Compute predictions
    results: dict[str, dict[str, Any]] = {}
    try:
        alive_probs = fitter.conditional_probability_alive(
            rfm["frequency"],
            rfm["recency"],
            rfm["T"],
        )
        expected_30d = fitter.conditional_expected_number_of_purchases_up_to_time(
            30,
            rfm["frequency"],
            rfm["recency"],
            rfm["T"],
        )
    except Exception:
        logger.exception("BG/NBD prediction failed")
        return {}

    # Determine high-value threshold
    alive_threshold = float(np.percentile(alive_probs, _HIGH_VALUE_PERCENTILE))

    for i, domain in enumerate(rfm.index):
        alive_p = float(alive_probs.iloc[i]) if hasattr(alive_probs, "iloc") else float(alive_probs[i])
        exp_30 = float(expected_30d.iloc[i]) if hasattr(expected_30d, "iloc") else float(expected_30d[i])
        recency_days = float(rfm.loc[domain, "T"] - rfm.loc[domain, "recency"])

        # Segment assignment
        if recency_days > _DORMANT_DAYS:
            segment = "dormant"
        elif alive_p >= alive_threshold:
            segment = "high_value"
        elif alive_p < 0.3:
            segment = "at_risk"
        else:
            segment = "regular"

        results[str(domain)] = {
            "alive_probability": round(alive_p, 3),
            "expected_contacts_30d": round(exp_30, 2),
            "segment": segment,
        }

    return results


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _compute_rfm(df: pd.DataFrame) -> pd.DataFrame | None:
    """Compute frequency, recency, T per sender domain.

    frequency: number of repeat transactions (total - 1)
    recency: time between first and last transaction (days)
    T: time between first transaction and observation end (days)
    """
    now = df["timestamp"].max()
    records: list[dict[str, Any]] = []

    for domain, group in df.groupby("from_domain"):
        if not domain or len(group) < _MIN_TRANSACTIONS:
            continue

        sorted_ts = group["timestamp"].sort_values()
        first = sorted_ts.iloc[0]
        last = sorted_ts.iloc[-1]

        frequency = len(group) - 1  # Repeat purchases
        recency = (last - first).total_seconds() / 86400
        t_val = (now - first).total_seconds() / 86400

        if t_val <= 0:
            continue

        records.append(
            {
                "domain": str(domain),
                "frequency": frequency,
                "recency": recency,
                "T": t_val,
            }
        )

    if not records:
        return None

    rfm = pd.DataFrame(records).set_index("domain")
    return rfm


@contextmanager
def _timeout(seconds: int):
    """Context manager that raises TimeoutError after `seconds`.

    Only works on Unix (uses SIGALRM). On other platforms, runs without timeout.
    """
    def _handler(signum, frame):
        raise TimeoutError(f"Operation timed out after {seconds}s")

    try:
        old_handler = signal.signal(signal.SIGALRM, _handler)
        signal.alarm(seconds)
        try:
            yield
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
    except (AttributeError, ValueError):
        # SIGALRM not available (Windows) or not main thread
        yield
