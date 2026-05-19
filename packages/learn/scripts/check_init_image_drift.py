"""Standalone init-image drift checker.

Background — 11:14Z incident
----------------------------
On 2026-05-19 the fleet ran for ~1 hour with a stale
``ssdavidai00/alfred-init:latest`` image on DockerHub. CI (build-alfred.yml)
had just shipped the OPS-TOKEN-1 fix (``chmod 0640`` on
``/alfred-data/.gateway-token``) at 06:30Z, but at 11:14Z something
out-of-band re-pushed an older image carrying the regressed
``chmod 600``. Every tenant's init container then reverted the token to
0600, which alfred-learn (uid 1000) cannot read. Briefs and every other
LLM call silently failed until CI was re-triggered at 11:34Z.

What this script does
---------------------
Pulls (or inspects, if already pulled) ``ssdavidai00/alfred-init:latest``
and asserts ``/setup/entrypoint.sh`` carries the OPS-TOKEN-1 markers:

  * ``chmod 0640 "$TOKEN_FILE"`` line PRESENT
  * ``chmod 600  "$TOKEN_FILE"`` line ABSENT

If drift is detected and the script is run with ``--emit-audit``, it
posts an ``image-drift`` audit row to ctrl-api so the event is captured
in the standard audit ledger (the same surface a Desk operator sees on
``/decisions``).

Two execution paths
-------------------
1. Local / CI / operator console — ``python -m scripts.check_init_image_drift``
   with the ``docker`` CLI on ``$PATH``. Pulls the image fresh and checks
   ``docker run --entrypoint /bin/cat``.

2. Inside alfred-learn at runtime — no Docker socket is mounted, so the
   Temporal workflow uses the DockerHub registry HTTP API instead (see
   ``src/activities/init_image_drift.py``). This standalone script
   prefers the docker-CLI path because it's robust against registry
   intermittents and is what operators reach for first.

Exit codes
----------
  0 — no drift detected, image is healthy.
  1 — drift detected (either chmod 0640 missing or chmod 600 present).
  2 — could not check (no docker CLI, no network, image not available).
      Treated separately from "drift detected" so callers can distinguish
      "image is bad" from "I can't tell".
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import shutil
import subprocess
import sys
from typing import Any

logger = logging.getLogger("check-init-image-drift")

INIT_IMAGE = os.environ.get("ALFRED_INIT_IMAGE", "ssdavidai00/alfred-init:latest")
ENTRYPOINT_PATH_IN_IMAGE = "/setup/entrypoint.sh"

# Both literal strings must be matched as fixed strings, not regex —
# ``$TOKEN_FILE`` ends with a regex anchor that would never match in
# default mode. The smoke step in build-alfred.yml uses ``grep -F`` for
# the same reason; keep these two checkers in lockstep.
MARKER_PRESENT = 'chmod 0640 "$TOKEN_FILE"'
MARKER_REGRESSED = 'chmod 600 "$TOKEN_FILE"'


def _check_via_docker_cli(image: str) -> tuple[int, str | None, str | None]:
    """Pull the image and read entrypoint.sh via ``docker run``.

    Returns ``(exit_code, content, error)``:
      * exit_code 0 + content       — happy path
      * exit_code 2 + error message — could not check (no docker / pull
        failed / image missing)
    """
    docker = shutil.which("docker")
    if docker is None:
        return 2, None, "docker CLI not on PATH"

    # docker pull failure is non-fatal here — operators may run this on a
    # box where the image is already cached and the registry is briefly
    # unreachable. We log + continue to docker run, which will then fail
    # with a clearer error if the image is genuinely missing.
    try:
        subprocess.run(
            [docker, "pull", image],
            check=False,
            capture_output=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        logger.warning("docker pull timed out — falling back to cached layer")

    try:
        proc = subprocess.run(
            [
                docker, "run", "--rm",
                "--entrypoint", "/bin/cat",
                image,
                ENTRYPOINT_PATH_IN_IMAGE,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return 2, None, "docker run timed out"

    if proc.returncode != 0:
        return 2, None, (
            f"docker run returned {proc.returncode}: "
            f"{proc.stderr.strip()[:300]}"
        )

    return 0, proc.stdout, None


def evaluate_entrypoint(content: str) -> dict[str, Any]:
    """Run the OPS-TOKEN-1 markers against the entrypoint content.

    Returns a dict the caller can serialise into an audit payload:
      * ``has_chmod_0640``       — bool, OPS-TOKEN-1 marker present
      * ``has_chmod_600``        — bool, regressed marker present
      * ``drift``                — bool, true iff either condition fails
      * ``reasons``              — list[str], human-readable failure causes
      * ``entrypoint_size_bytes``— int, for sanity-checking the source

    No I/O — caller is responsible for fetching the entrypoint text. This
    keeps the predicate trivially unit-testable.
    """
    has_0640 = MARKER_PRESENT in content
    has_600 = MARKER_REGRESSED in content
    reasons: list[str] = []
    if not has_0640:
        reasons.append(
            f"missing OPS-TOKEN-1 marker: {MARKER_PRESENT!r}"
        )
    if has_600:
        reasons.append(
            f"regressed marker present: {MARKER_REGRESSED!r}"
        )
    return {
        "has_chmod_0640": has_0640,
        "has_chmod_600": has_600,
        "drift": bool(reasons),
        "reasons": reasons,
        "entrypoint_size_bytes": len(content.encode("utf-8")),
    }


async def _post_audit(image: str, evaluation: dict[str, Any]) -> bool:
    """POST a drift row to ``/api/v1/audit`` via the existing helper.

    Returns True on a successful post, False otherwise. Best-effort —
    a failed post does NOT raise; the script's exit code already
    surfaces the actual drift state and audit emission is observability,
    not correctness.
    """
    try:
        from src.activities.audit_writer import write_audit_safe
    except ImportError as exc:
        logger.warning(
            "could not import audit_writer (run from learn container?): %s",
            exc,
        )
        return False

    payload = {
        "image": image,
        **evaluation,
    }
    result = await write_audit_safe(
        actor="alfred-learn:image-drift-detector",
        action_type="image-drift",
        target_type="docker-image",
        target_id=image,
        payload=payload,
        reasoning="; ".join(evaluation.get("reasons", [])) or None,
        reversible=False,
    )
    return result is not None


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(
        description="Check ssdavidai00/alfred-init:latest for OPS-TOKEN-1 drift.",
    )
    parser.add_argument(
        "--image", default=INIT_IMAGE,
        help=f"Image to inspect (default: {INIT_IMAGE})",
    )
    parser.add_argument(
        "--emit-audit", action="store_true",
        help="POST an image-drift audit row to ctrl-api on drift detection.",
    )
    args = parser.parse_args()

    rc, content, err = _check_via_docker_cli(args.image)
    if rc != 0 or content is None:
        logger.error("could not check %s: %s", args.image, err)
        return 2

    evaluation = evaluate_entrypoint(content)
    image = args.image
    if evaluation["drift"]:
        logger.error(
            "DRIFT DETECTED in %s: %s", image, "; ".join(evaluation["reasons"]),
        )
        if args.emit_audit:
            posted = asyncio.run(_post_audit(image, evaluation))
            logger.info("audit post: %s", "OK" if posted else "FAILED")
        return 1

    logger.info(
        "OK: %s has OPS-TOKEN-1 marker (chmod 0640), no regressed chmod 600 "
        "(entrypoint=%d bytes)",
        image, evaluation["entrypoint_size_bytes"],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
