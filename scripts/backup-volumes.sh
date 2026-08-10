#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-alfred-black}"
OUTPUT_DIR=""
ONLINE=0

VOLUMES=(
  vault_data
  files_data
  files_cold_data
  state_data
  ingest_data
  cold_data
  hermes_data
  alfred_data
  caddy_data
  caddy_config
  vaultwarden_data
  web_db_data
  temporal_data
  mcp_server_data
  sure_pgdata
  sure_redis
  paperclip_data
  tailscale_data
  ollama_data
  hermes_codex_work
)

usage() {
  cat <<'USAGE'
Usage: scripts/backup-volumes.sh [--online] --output <directory>

Creates one .tgz archive and one .sha256 file per existing Alfred Docker volume.

Default mode refuses to run while project containers are running, so database
volumes are quiesced. Stop the stack first:

  docker compose stop
  scripts/backup-volumes.sh --output /mnt/encrypted/alfred-backups/$(date -u +%Y%m%dT%H%M%SZ)
  docker compose up -d

Use --online only for a best-effort live archive. Online archives of database
volumes may not be transaction-consistent.

Environment:
  COMPOSE_PROJECT_NAME   Docker Compose project prefix; defaults to alfred-black.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --online)
      ONLINE=1
      shift
      ;;
    --output|-o)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$OUTPUT_DIR" ]]; then
  echo "Missing required --output <directory>" >&2
  usage >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required" >&2
  exit 1
fi

if [[ "$ONLINE" -ne 1 ]]; then
  running_containers="$(docker compose ps --status running -q 2>/dev/null || true)"
  if [[ -n "$running_containers" ]]; then
    echo "Project containers are running. Stop them first, or pass --online for a best-effort archive." >&2
    exit 1
  fi
fi

mkdir -p "$OUTPUT_DIR"
manifest="$OUTPUT_DIR/manifest.txt"
{
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "project_name=$PROJECT_NAME"
  echo "mode=$([[ "$ONLINE" -eq 1 ]] && echo online || echo quiesced)"
  echo
} > "$manifest"

for volume in "${VOLUMES[@]}"; do
  docker_volume="${PROJECT_NAME}_${volume}"
  if ! docker volume inspect "$docker_volume" >/dev/null 2>&1; then
    echo "skip missing $docker_volume" | tee -a "$manifest"
    continue
  fi

  archive="$OUTPUT_DIR/${volume}.tgz"
  echo "archiving $docker_volume -> $archive"
  docker run --rm \
    -v "${docker_volume}:/data:ro" \
    -v "${OUTPUT_DIR}:/backup" \
    alpine:3.20 \
    sh -c "cd /data && tar -czf /backup/${volume}.tgz ."

  sha256sum "$archive" > "${archive}.sha256"
  size_bytes="$(stat -c %s "$archive")"
  checksum="$(cut -d' ' -f1 "${archive}.sha256")"
  echo "${volume} ${docker_volume} ${size_bytes} ${checksum}" >> "$manifest"
done

echo "backup manifest: $manifest"
