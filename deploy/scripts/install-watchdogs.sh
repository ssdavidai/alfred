#!/bin/bash
# install-watchdogs.sh: idempotently install both openclaw watchdog crons on
# the current tenant VM. Run via:
#
#   scp deploy/scripts/install-watchdogs.sh \
#       deploy/scripts/alfred-workers-watchdog.sh \
#       deploy/scripts/alfred-trajectory-cleanup.sh \
#       <tenant>:/tmp/
#   ssh <tenant> 'bash /tmp/install-watchdogs.sh'
#
# Both watchdogs run from the deploy user's crontab. Safe to re-run — the
# script de-dups its own crontab entries by exact line match.

set -euo pipefail

INSTALL_DIR=/opt/alfred/scripts
mkdir -p "$INSTALL_DIR"

# Source the scripts from /tmp (where scp drops them) or from the same dir
# as this installer (when running checked-out from the repo).
src_dir="$(dirname "$(readlink -f "$0")")"
if [ ! -f "$src_dir/alfred-workers-watchdog.sh" ]; then
  src_dir=/tmp
fi

for script in alfred-workers-watchdog.sh alfred-trajectory-cleanup.sh; do
  if [ ! -f "$src_dir/$script" ]; then
    echo "ERROR: $src_dir/$script not found" >&2
    exit 1
  fi
  cp "$src_dir/$script" "$INSTALL_DIR/$script"
  chmod +x "$INSTALL_DIR/$script"
  echo "installed $INSTALL_DIR/$script"
done

# Touch log files so the scripts can append on first run.
touch /opt/alfred/alfred-workers-watchdog.log
touch /opt/alfred/alfred-trajectory-cleanup.log

# Crontab — install both entries idempotently. Existing entries (exact
# line match) are preserved; missing ones are appended. The trajectory
# cleanup runs at xx:07/22/37/52 — offset from the workers-watchdog
# (xx:00/15/30/45) so they don't compete for the same minute.
WATCHDOG_LINE="*/15 * * * * /opt/alfred/scripts/alfred-workers-watchdog.sh"
TRAJECTORY_LINE="7,22,37,52 * * * * /opt/alfred/scripts/alfred-trajectory-cleanup.sh"
TRAJECTORY_OLD_LINE="30 4 * * * /opt/alfred/scripts/alfred-trajectory-cleanup.sh"

existing=$(crontab -l 2>/dev/null || true)
# Drop the old daily-at-04:30 entry if present (superseded by 15-min cadence).
existing="$(printf '%s\n' "$existing" | grep -vxF "$TRAJECTORY_OLD_LINE" || true)"
new="$existing"

if ! echo "$existing" | grep -qxF "$WATCHDOG_LINE"; then
  new="$(printf '%s\n%s\n' "$new" "$WATCHDOG_LINE")"
  echo "+ scheduled alfred-workers-watchdog (every 15 min)"
fi

if ! echo "$existing" | grep -qxF "$TRAJECTORY_LINE"; then
  new="$(printf '%s\n%s\n' "$new" "$TRAJECTORY_LINE")"
  echo "+ scheduled alfred-trajectory-cleanup (every 15 min)"
fi

# Only update crontab if anything changed; avoids spurious mtime bumps.
if [ "$new" != "$existing" ]; then
  printf '%s\n' "$new" | sed '/^$/d' | crontab -
fi

echo "--- current crontab ---"
crontab -l
echo "--- watchdog dry run ---"
"$INSTALL_DIR/alfred-trajectory-cleanup.sh" && echo "trajectory cleanup OK"
"$INSTALL_DIR/alfred-workers-watchdog.sh" && echo "workers watchdog OK"
echo "--- install complete ---"
