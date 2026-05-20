#!/usr/bin/env bash
# setup.sh — One-click Alfred setup for existing OpenClaw users.
#
# Prerequisites: Python 3.11+, OpenClaw on PATH
# Usage: ./setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BOLD}$*${NC}"; }
ok()    { echo -e "  ${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "  ${YELLOW}[!!]${NC} $*"; }
fail()  { echo -e "  ${RED}[FAIL]${NC} $*"; exit 1; }

# --- Prerequisite checks ---

require_cmd() {
    if ! command -v "$1" &>/dev/null; then
        fail "$1 not found on PATH. $2"
    fi
    ok "$1 found"
}

check_python_version() {
    local version
    version=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    local major minor
    major=$(echo "$version" | cut -d. -f1)
    minor=$(echo "$version" | cut -d. -f2)
    if [[ "$major" -lt 3 ]] || { [[ "$major" -eq 3 ]] && [[ "$minor" -lt 11 ]]; }; then
        fail "Python 3.11+ required, found $version"
    fi
    ok "Python $version"
}

echo ""
echo "========================================"
echo "  Alfred + OpenClaw  —  One-Click Setup"
echo "========================================"
echo ""

info "Checking prerequisites..."
require_cmd python3 "Install Python 3.11+ first."
check_python_version
require_cmd openclaw "Install OpenClaw first: npm install -g openclaw"

# --- Locate the in-repo Alfred vault package ---
# This script ships inside the Alfred monorepo; the alfred-vault package
# lives at <repo>/packages/alfred-vault. No external clone — the source is
# already here. Update by running `git pull` on the monorepo itself.

echo ""
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ALFRED_DIR="${ALFRED_DIR:-$REPO_ROOT/packages/alfred-vault}"
if [[ ! -f "$ALFRED_DIR/pyproject.toml" ]]; then
    fail "alfred-vault package not found at $ALFRED_DIR — run this script from a checkout of the Alfred monorepo (or set ALFRED_DIR)."
fi
ok "Using in-repo alfred-vault at $ALFRED_DIR"
cd "$ALFRED_DIR"

# --- Install Alfred + surveyor deps ---

echo ""
info "Installing Alfred with all dependencies (including surveyor)..."
pip install -e ".[all]" --quiet
ok "Alfred installed"

# --- Create vault ---

echo ""
DEFAULT_VAULT="$HOME/vault"
read -r -p "Vault path [$DEFAULT_VAULT]: " VAULT_PATH
VAULT_PATH="${VAULT_PATH:-$DEFAULT_VAULT}"
# Resolve to absolute path
VAULT_PATH="$(cd "$(dirname "$VAULT_PATH")" 2>/dev/null && pwd)/$(basename "$VAULT_PATH")" 2>/dev/null || VAULT_PATH="$(realpath -m "$VAULT_PATH")"

# Resolve the bundled scaffold from the installed package (works regardless
# of the package's on-disk layout).
SCAFFOLD_DIR="$(python3 -c 'from alfred._data import get_scaffold_dir; print(get_scaffold_dir())')"

if [[ ! -d "$VAULT_PATH" ]]; then
    info "Creating vault at $VAULT_PATH from scaffold..."
    cp -r "$SCAFFOLD_DIR" "$VAULT_PATH"
    ok "Vault scaffolded"
else
    ok "Vault directory already exists at $VAULT_PATH"
fi

# Ensure all entity dirs exist
ENTITY_DIRS=(
    person project org location process
    inbox inbox/processed
    account asset conversation note
    decision assumption constraint contradiction synthesis
    event dashboard view
)
for dir in "${ENTITY_DIRS[@]}"; do
    mkdir -p "$VAULT_PATH/$dir"
done
ok "All entity directories present"

# --- Copy skills to OpenClaw workspace ---

echo ""
info "Copying Alfred skills to OpenClaw workspace..."
OPENCLAW_SKILLS="$HOME/.openclaw/workspace/skills"
mkdir -p "$OPENCLAW_SKILLS"

ALFRED_SKILLS_DIR="$(python3 -c 'from alfred._data import get_skills_dir; print(get_skills_dir())')"
for skill in vault-curator vault-janitor vault-distiller; do
    rm -rf "${OPENCLAW_SKILLS:?}/$skill"
    cp -r "$ALFRED_SKILLS_DIR/$skill" "$OPENCLAW_SKILLS/$skill"
done
ok "Skills copied to $OPENCLAW_SKILLS"

# --- Install openclaw-wrapper ---

WRAPPER_PATH="$ALFRED_DIR/openclaw-wrapper"
cp "$SCRIPT_DIR/openclaw-wrapper" "$WRAPPER_PATH"
chmod +x "$WRAPPER_PATH"
ok "openclaw-wrapper installed to $WRAPPER_PATH"

# --- API key ---

echo ""
read -r -p "OpenRouter API key (for surveyor embeddings): " OPENROUTER_KEY
if [[ -z "$OPENROUTER_KEY" ]]; then
    warn "No key provided — you'll need to set OPENROUTER_API_KEY in $ALFRED_DIR/.env later"
fi

# --- Generate config.yaml ---

echo ""
info "Generating config.yaml..."

export VAULT_PATH
export OPENCLAW_WRAPPER_PATH="$WRAPPER_PATH"
export DATA_DIR="./data"
export OPENROUTER_API_KEY="${OPENROUTER_KEY}"
envsubst < "$SCRIPT_DIR/config.yaml.tpl" > "$ALFRED_DIR/config.yaml"

ok "config.yaml written"

# --- Generate .env ---

cat > "$ALFRED_DIR/.env" <<ENV
# Alfred environment variables
OPENROUTER_API_KEY=$OPENROUTER_KEY
ENV

ok ".env written"

# --- Create data dir ---

mkdir -p "$ALFRED_DIR/data"
ok "data/ directory ready"

# --- Done ---

echo ""
echo "========================================"
echo "  Setup complete!"
echo "========================================"
echo ""
echo "  Vault:     $VAULT_PATH"
echo "  Alfred:    $ALFRED_DIR"
echo "  Backend:   openclaw (via wrapper)"
echo "  Embeddings: OpenRouter text-embedding-3-small"
echo ""
echo "  Next steps:"
echo "    1. Make sure OpenClaw gateway is running:"
echo "       openclaw gateway"
echo ""
echo "    2. Start Alfred:"
echo "       cd $ALFRED_DIR && alfred up"
echo ""
echo "    3. Drop a file in $VAULT_PATH/inbox/ to test the curator"
echo ""
