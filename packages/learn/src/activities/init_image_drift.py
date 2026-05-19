"""init-image drift detection activity.

Background — 11:14Z incident on 2026-05-19
-------------------------------------------
The fleet ran for ~1 hour with a stale ``ssdavidai00/alfred-init:latest``
on DockerHub. CI had built the OPS-TOKEN-1 fix (``chmod 0640`` on
``/alfred-data/.gateway-token``) at 06:30Z, but something out-of-band
re-pushed an older image at 11:14Z carrying the regressed ``chmod 600``.
Every tenant's init container then reverted the token to 0600, which
alfred-learn (uid 1000) cannot read — briefs and every other LLM call
silently failed. The CI re-trigger at 11:34Z replaced the bad image, but
the failure mode is open-ended: anything with DockerHub push rights can
overwrite the latest tag.

This activity is the runtime side of the detection net:

  * The CI smoke step in ``.github/workflows/build-alfred.yml`` catches
    the case where CI's OWN build produces a stale image (it pulls back
    what was just pushed and re-asserts).
  * This activity catches drift from any other source — it runs
    periodically (registered in ``scripts/register_schedules.py`` as
    ``al-init-image-drift``, SKIP overlap, daily cadence) and writes an
    ``image-drift`` row to the audit ledger when the latest image stops
    carrying the OPS-TOKEN-1 marker.

Why the registry HTTP API and not ``docker`` CLI
------------------------------------------------
alfred-learn does NOT have ``/var/run/docker.sock`` mounted (see
``packages/ctrl/src/templates/docker-compose.yaml.njk``; only ctrl-api
has the socket). We could plumb a new ctrl-api endpoint that shells out
to ``docker inspect``, but that's another surface to secure for one
read-only check. Instead this activity talks to DockerHub's registry v2
HTTP API directly:

  1. Auth — DockerHub gives anonymous pull tokens for public images.
  2. Manifest — list the layers in ``ssdavidai00/alfred-init:latest``.
  3. Blobs — newest-first, download each gzip-tar layer and look for
     ``setup/entrypoint.sh`` inside. Bail out as soon as the file is
     found (the entrypoint sits in a small late layer added by the
     ``COPY packages/openclaw/init/entrypoint.sh ./entrypoint.sh``
     Dockerfile line, so we typically inspect 1-2 layers, not all of
     them).
  4. Match — apply the same OPS-TOKEN-1 markers the CI smoke uses.

Idempotent + cheap: each tick re-downloads a few MB of compressed
layers. The whole check completes in seconds even on a cold cache.
"""
from __future__ import annotations

import gzip
import io
import logging
import os
import tarfile
from typing import Any

import httpx
from temporalio import activity

logger = logging.getLogger("alfred-learn.init-image-drift")

INIT_IMAGE_REPO = os.environ.get(
    "ALFRED_INIT_IMAGE_REPO", "ssdavidai00/alfred-init",
)
INIT_IMAGE_TAG = os.environ.get("ALFRED_INIT_IMAGE_TAG", "latest")

# Inside the image the entrypoint lives at ``/setup/entrypoint.sh``
# (see ``packages/openclaw/init/Dockerfile``). When that file is laid
# down by a Docker COPY it appears in the tarball under the relative
# path ``setup/entrypoint.sh`` — no leading slash.
ENTRYPOINT_TAR_PATH = "setup/entrypoint.sh"

# Mirror the smoke step's literal-string match. ``$TOKEN_FILE`` is not
# a regex anchor here — we use raw ``in`` membership on the decoded
# string so ``$`` keeps its literal meaning by definition.
MARKER_PRESENT = 'chmod 0640 "$TOKEN_FILE"'
MARKER_REGRESSED = 'chmod 600 "$TOKEN_FILE"'

# Registry endpoints. The auth service mints a short-lived pull token
# that the registry then accepts on the Bearer header.
_AUTH_URL = "https://auth.docker.io/token"
_REGISTRY_BASE = "https://registry-1.docker.io/v2"

# Media types we accept on the manifest GET. ``manifest.list.v2+json``
# and ``index.v1+json`` are multi-arch indexes; the single-arch
# ``manifest.v2+json`` is what we want a layer list from.
_ACCEPT_MANIFEST = ", ".join([
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json",
])


async def _get_pull_token(
    client: httpx.AsyncClient, repo: str,
) -> str:
    """Mint an anonymous pull token for ``repo`` from DockerHub auth."""
    resp = await client.get(
        _AUTH_URL,
        params={
            "service": "registry.docker.io",
            "scope": f"repository:{repo}:pull",
        },
    )
    resp.raise_for_status()
    data = resp.json()
    token = data.get("token") or data.get("access_token") or ""
    if not token:
        raise RuntimeError("registry auth returned no token")
    return token


async def _fetch_manifest(
    client: httpx.AsyncClient, repo: str, ref: str, token: str,
) -> dict[str, Any]:
    """GET the manifest JSON for ``repo:ref``.

    If the response is an index/list (multi-arch), recurse into the
    amd64 entry — the alfred-init image is built for amd64 only
    (Hetzner servers are x86_64; see ``build-images.sh``'s
    ``--platform linux/amd64`` flag).
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": _ACCEPT_MANIFEST,
    }
    resp = await client.get(
        f"{_REGISTRY_BASE}/{repo}/manifests/{ref}", headers=headers,
    )
    resp.raise_for_status()
    manifest = resp.json()

    media_type = (
        manifest.get("mediaType")
        or resp.headers.get("Content-Type", "").split(";")[0].strip()
    )
    is_index = media_type.endswith(("index.v1+json", "list.v2+json"))
    if is_index:
        manifests = manifest.get("manifests") or []
        amd64_digest = None
        for entry in manifests:
            platform = entry.get("platform") or {}
            if (
                platform.get("architecture") == "amd64"
                and platform.get("os") == "linux"
            ):
                amd64_digest = entry.get("digest")
                break
        if amd64_digest is None:
            raise RuntimeError(
                "registry returned a multi-arch index with no amd64 entry "
                f"(repo={repo} ref={ref})",
            )
        return await _fetch_manifest(client, repo, amd64_digest, token)
    return manifest


async def _fetch_layer_blob(
    client: httpx.AsyncClient, repo: str, digest: str, token: str,
) -> bytes:
    """GET a single layer blob by digest. Returns raw bytes."""
    headers = {"Authorization": f"Bearer {token}"}
    # The registry redirects to a CDN URL on the first GET; httpx
    # follows by default.
    resp = await client.get(
        f"{_REGISTRY_BASE}/{repo}/blobs/{digest}",
        headers=headers,
        follow_redirects=True,
    )
    resp.raise_for_status()
    return resp.content


def _extract_entrypoint_from_layer(
    blob: bytes, member_path: str,
) -> str | None:
    """Try to read ``member_path`` out of a gzip-tar layer blob.

    Returns the decoded file content as a string, or None if the layer
    doesn't contain that path. Layers are gzip-tar by default for
    Docker v2 manifests; ``layer.tar`` (uncompressed) is uncommon but
    we handle it as a fallback. Anything else raises — we want a noisy
    failure rather than a quiet false negative.
    """
    buf = io.BytesIO(blob)
    # Try gzip first; if it isn't gzip, gzip.GzipFile raises OSError on
    # read. Fall through to raw tar on that path.
    try:
        with gzip.GzipFile(fileobj=buf) as gz:
            tar_bytes = gz.read()
    except OSError:
        tar_bytes = blob

    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as tf:
        # Also handle the case where Docker emits with a leading ``./``
        # before the relative path. The Dockerfile generally produces
        # ``setup/entrypoint.sh`` directly, but BuildKit occasionally
        # writes ``./setup/entrypoint.sh`` — tolerate both.
        candidates = {member_path, f"./{member_path}"}
        for member in tf.getmembers():
            if member.name in candidates and member.isfile():
                f = tf.extractfile(member)
                if f is None:
                    return None
                return f.read().decode("utf-8", errors="replace")
    return None


async def _read_entrypoint_from_registry(
    repo: str, tag: str, http_timeout: float,
) -> tuple[str | None, dict[str, Any]]:
    """Fetch ``setup/entrypoint.sh`` from the registry.

    Returns ``(content, meta)`` where ``meta`` carries enough breadcrumbs
    (layer count, layer digests scanned, total bytes scanned) to land in
    an audit payload for forensics on a drift event.
    """
    meta: dict[str, Any] = {
        "repo": repo,
        "tag": tag,
        "layers_scanned": 0,
        "bytes_scanned": 0,
        "scanned_layer_digests": [],
    }

    async with httpx.AsyncClient(timeout=http_timeout) as client:
        token = await _get_pull_token(client, repo)
        manifest = await _fetch_manifest(client, repo, tag, token)
        layers = manifest.get("layers") or []
        meta["total_layers"] = len(layers)

        # entrypoint.sh is added late in the Dockerfile (line ~67 in
        # init/Dockerfile, well after the pip install / sqlite-vec
        # blocks), so it sits near the END of the layer list. Reverse-
        # walk so we find it in 1-2 layers on a healthy image.
        for layer in reversed(layers):
            digest = layer.get("digest")
            if not digest:
                continue
            blob = await _fetch_layer_blob(client, repo, digest, token)
            meta["layers_scanned"] += 1
            meta["bytes_scanned"] += len(blob)
            meta["scanned_layer_digests"].append(digest)

            try:
                content = _extract_entrypoint_from_layer(
                    blob, ENTRYPOINT_TAR_PATH,
                )
            except (OSError, tarfile.TarError) as exc:
                # A single bad layer (e.g. an attestation blob, not a
                # filesystem layer) shouldn't sink the whole check.
                # Log + continue.
                logger.debug(
                    "layer %s could not be parsed as tar: %s", digest, exc,
                )
                continue
            if content is not None:
                meta["found_in_digest"] = digest
                return content, meta

    return None, meta


def evaluate_entrypoint(content: str) -> dict[str, Any]:
    """Apply the OPS-TOKEN-1 markers.

    Pure function; same predicate as the CLI script
    (``scripts/check_init_image_drift.py``). Keep the two in sync.
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


@activity.defn
async def check_init_image_drift(
    repo: str | None = None,
    tag: str | None = None,
    http_timeout: float = 60.0,
) -> dict[str, Any]:
    """Pull the init image manifest, extract entrypoint.sh, eval markers.

    Returns a dict with:

    * ``checked`` (bool) — True if we reached the eval stage
    * ``drift``   (bool) — True iff markers fail
    * ``reasons`` (list[str]) — human-readable drift causes
    * ``has_chmod_0640`` / ``has_chmod_600`` — raw marker booleans
    * ``image`` — fully-qualified ``repo:tag`` we inspected
    * ``layers_scanned`` / ``bytes_scanned`` — registry breadcrumbs
    * ``error`` — populated on the could-not-check path
    """
    repo = repo or INIT_IMAGE_REPO
    tag = tag or INIT_IMAGE_TAG
    image = f"{repo}:{tag}"

    activity.logger.info(
        "check_init_image_drift.start image=%s", image,
    )

    try:
        content, meta = await _read_entrypoint_from_registry(
            repo, tag, http_timeout,
        )
    except httpx.HTTPError as exc:
        activity.logger.warning(
            "check_init_image_drift: registry transport error: %s", exc,
        )
        return {
            "checked": False,
            "drift": False,
            "image": image,
            "error": f"transport: {exc}",
        }
    except Exception as exc:  # noqa: BLE001
        activity.logger.warning(
            "check_init_image_drift: unexpected error: %r", exc,
        )
        return {
            "checked": False,
            "drift": False,
            "image": image,
            "error": f"unexpected: {exc!r}",
        }

    if content is None:
        activity.logger.warning(
            "check_init_image_drift: entrypoint.sh not found in any layer "
            "(layers_scanned=%d total_layers=%d)",
            meta.get("layers_scanned", 0), meta.get("total_layers", 0),
        )
        return {
            "checked": False,
            "drift": False,
            "image": image,
            "error": "entrypoint.sh not found in any layer",
            **meta,
        }

    evaluation = evaluate_entrypoint(content)
    activity.logger.info(
        "check_init_image_drift.done image=%s drift=%s "
        "has_0640=%s has_600=%s layers_scanned=%d",
        image, evaluation["drift"],
        evaluation["has_chmod_0640"],
        evaluation["has_chmod_600"],
        meta.get("layers_scanned", 0),
    )
    return {
        "checked": True,
        "image": image,
        **evaluation,
        **meta,
    }


@activity.defn
async def emit_init_image_drift_audit(
    drift_report: dict[str, Any],
) -> dict[str, Any]:
    """Forward a drift report to ``POST /api/v1/audit``.

    Only invoked when ``check_init_image_drift`` returned ``drift=True``.
    The audit row goes to the unified audit ledger (action_type
    ``image-drift``) so the event is visible in ``/decisions`` and any
    downstream alerting wired off the audit feed. Best-effort: a
    transport failure logs but doesn't raise, mirroring
    ``write_audit_safe``'s contract.
    """
    # Import inside the activity body so the worker module can register
    # this without dragging the audit_writer module's httpx client setup
    # into module-load time.
    from src.activities.audit_writer import write_audit_safe

    image = drift_report.get("image") or "ssdavidai00/alfred-init:latest"
    reasons = drift_report.get("reasons") or []
    result = await write_audit_safe(
        actor="alfred-learn:image-drift-detector",
        action_type="image-drift",
        target_type="docker-image",
        target_id=image,
        payload=drift_report,
        reasoning="; ".join(reasons) if reasons else None,
        reversible=False,
    )
    posted = result is not None
    activity.logger.info(
        "emit_init_image_drift_audit: posted=%s image=%s", posted, image,
    )
    return {"posted": posted, "audit_id": (result or {}).get("id")}


__all__ = [
    "INIT_IMAGE_REPO",
    "INIT_IMAGE_TAG",
    "MARKER_PRESENT",
    "MARKER_REGRESSED",
    "check_init_image_drift",
    "emit_init_image_drift_audit",
    "evaluate_entrypoint",
]
