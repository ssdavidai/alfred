#!/bin/sh
# audit-rescue.sh — STORE-P0-3 tactical rescue
#
# Walks /mnt/encrypted/vault/event/ and moves mis-filed audit records into
# their typed subdirs (signal_action/, steward_action/, desk_action/, ...).
#
# Designed to be run inside compose-ctrl-api-1 on each tenant so the moves
# happen as the correct uid (1000:1001) with read+write access to the
# encrypted vault. Manifest written to /mnt/encrypted/vault/_rescue/ inside
# the container (i.e. on the host vault) so it survives container restarts.
#
# Idempotent: skips files that already exist at the destination.
# No deletions. Only `mv`. Manifest is the rollback path.
#
# Usage (per tenant, smallest first):
#   ssh raj313  'docker exec compose-ctrl-api-1 sh /mnt/encrypted/vault/_rescue/audit-rescue.sh'
#   ssh miguel  'docker exec compose-ctrl-api-1 sh /mnt/encrypted/vault/_rescue/audit-rescue.sh'
#   ssh rapali  'docker exec compose-ctrl-api-1 sh /mnt/encrypted/vault/_rescue/audit-rescue.sh'
#   ssh david   'docker exec compose-ctrl-api-1 sh /mnt/encrypted/vault/_rescue/audit-rescue.sh'

set -eu

VAULT="${VAULT:-/mnt/encrypted/vault}"
EVENT_DIR="$VAULT/event"
MANIFEST_DIR="$VAULT/_rescue"
mkdir -p "$MANIFEST_DIR"
DATE_TAG="$(date +%Y-%m-%d)"
MANIFEST="$MANIFEST_DIR/audit-rescue-${DATE_TAG}.log"
SKIPPED="$MANIFEST_DIR/audit-rescue-${DATE_TAG}.skipped.log"
UNKNOWN="$MANIFEST_DIR/audit-rescue-${DATE_TAG}.unknown.log"

# touch logs
: >> "$MANIFEST"
: >> "$SKIPPED"
: >> "$UNKNOWN"

moved=0
skipped=0
unknown=0
total=0

# Map filename prefix -> destination dir (underscore form).
# We use prefix matching because the type: field can be buried deep in the
# frontmatter, but the naming convention is consistent across writers.
prefix_to_dir() {
  case "$1" in
    signal-action-*)            echo signal_action ;;
    steward-action-*)           echo steward_action ;;
    desk-action-*)               echo desk_action ;;
    needs-attention-action-*)   echo needs_attention_action ;;
    needs_attention_action-*)   echo needs_attention_action ;;
    auto-task-created-*)         echo auto_task_created ;;
    state-change-*)              echo state_change ;;
    steward-source-pruned-*)    echo steward_source_pruned ;;
    daily-digest-*)              echo daily_digest ;;
    daily-brief-*)               echo daily_brief ;;
    *) echo "" ;;
  esac
}

# Walk only top-level *.md in event/. Don't recurse into subdirs (those are
# legitimate event types we shouldn't touch).
for src in "$EVENT_DIR"/*.md; do
  [ -e "$src" ] || continue   # no matches -> glob stays literal
  total=$((total+1))
  base="$(basename "$src")"
  dest_sub="$(prefix_to_dir "$base")"

  if [ -z "$dest_sub" ]; then
    # not a known audit prefix -> leave it; log as unknown
    echo "$src" >> "$UNKNOWN"
    unknown=$((unknown+1))
    continue
  fi

  dest_dir="$VAULT/$dest_sub"
  mkdir -p "$dest_dir"
  dest="$dest_dir/$base"

  if [ -e "$dest" ]; then
    # idempotent skip — destination already populated by a prior run
    echo "skip $src (exists at $dest)" >> "$SKIPPED"
    skipped=$((skipped+1))
    continue
  fi

  mv "$src" "$dest"
  echo "mv $src $dest" >> "$MANIFEST"
  moved=$((moved+1))
done

echo "audit-rescue done: scanned=$total moved=$moved skipped=$skipped unknown=$unknown"
echo "manifest: $MANIFEST"
echo "unknown:  $UNKNOWN"
echo "skipped:  $SKIPPED"
