# Semantic Drift Monitor Security Review

**Date:** 2026-02-24  
**Project:** `alfred`  
**Scope:** Surveyor semantic drift monitor (`drift.py`, `drift_cli.py`, daemon integration)

## Summary

This review documents issues identified during adversarial/security analysis of the Semantic Drift Monitor implementation, the remediation executed, and remaining concerns.

## Remediated Issues

### 1. Drift artifact corruption could crash Surveyor (availability risk)

- **Issue:** malformed snapshot/report JSON could raise unhandled exceptions and break drift processing, with potential pipeline impact.
- **Remediation:**
  - unreadable/corrupt snapshots are now skipped with warning logs.
  - invalid report JSON now returns controlled validation errors.
  - daemon wraps drift processing in `try/except` to prevent pipeline failure.
- **References:**
  - `src/alfred/surveyor/drift.py`
  - `src/alfred/surveyor/daemon.py`

### 2. `alfred drift show` accepted absolute paths (path confinement issue)

- **Issue:** report lookup previously allowed absolute paths, enabling reads outside `data/semantic_drift`.
- **Remediation:**
  - report input is now constrained to filename-only.
  - absolute paths and traversal-style inputs are rejected.
  - resolved path is verified to remain within `data/semantic_drift`.
- **References:**
  - `src/alfred/surveyor/drift.py`
  - `src/alfred/surveyor/drift_cli.py`

### 3. Non-atomic snapshot/report writes (corruption risk)

- **Issue:** direct writes to final files could leave partial JSON on interruption.
- **Remediation:**
  - writes now use temp file + atomic `os.replace`.
- **References:**
  - `src/alfred/surveyor/drift.py`

### 4. Unbounded report growth (storage/DoS risk)

- **Issue:** snapshots had retention; reports did not.
- **Remediation:**
  - added report pruning with same retention cap as snapshots.
- **References:**
  - `src/alfred/surveyor/drift.py`

### 5. Missing validation for drift config bounds

- **Issue:** invalid threshold/retention values could produce unstable behavior.
- **Remediation:**
  - `similarity_threshold` normalized to `[0.0, 1.0]`.
  - `snapshot_retention` normalized to integer `>= 1`.
- **References:**
  - `src/alfred/surveyor/drift.py`

## Remaining Concerns

### 1. Local write access can still induce churn before pruning

- A user/process with local write access could create many valid drift artifacts between runs.
- Retention limits steady-state footprint but does not fully prevent short-window file churn.

### 2. No cryptographic integrity/authentication on drift artifacts

- Drift snapshots/reports are trusted as local JSON.
- Tampering is detectable only by behavior/anomalies, not by signatures or checksums.

### 3. Drift artifacts include vault topology metadata

- Stored member lists and labels may be sensitive in some environments.
- File-permission and data-governance posture depends on host OS/user configuration.

## Verification Performed

- Static review of drift code paths and CLI input handling.
- Compile validation:
  - `python -m compileall src/alfred/surveyor/drift.py src/alfred/surveyor/daemon.py src/alfred/surveyor/drift_cli.py`

## Recommended Next Hardening Steps

1. Add optional artifact integrity checks (hash or signature).
2. Add filesystem permission checks/warnings for `data/semantic_*` directories.
3. Add tests for corrupted JSON recovery and path-confinement behavior.
