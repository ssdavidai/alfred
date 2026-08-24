# =============================================================================
# alfred-black-hermes — the single AI runtime image.
#
# Replaces BOTH OpenClaw containers (`openclaw` :18789 + `openclaw-workers`
# :18790). Hermes profiles give each side its own API port, key, config and
# SQLite SessionStore — the same isolation boundary, at near-zero cost: one
# image, one extra ~150 MB Python process instead of a whole second Node
# container.
#
# The container runs TWO supervised processes (see docker/supervisor.sh):
#   hermes -p main    gateway run   — user-facing chat, Hermes API on :18789
#   hermes -p workers gateway run   — background agents, Hermes API on :18790
# The hermes-shim was retired (issue #40): the Hermes API server binds the
# canonical ports directly; callers speak the Hermes /v1 API natively.
#
# BUILD CONTEXT: the alfred-black monorepo root. All COPY paths are
# repo-relative (matches the init container's `context: .` convention).
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — build the 5-app MCP stdio bundle from packages/mcp-server.
#
# Same TypeScript source the HTTP alfred-mcp-server is built from. The
# Hermes runtime spawns each of the 5 apps (alfred/sure/plane/vaultwarden/
# execute) as a stdio MCP child process. We ship the compiled bundle so the
# runtime image needs no build toolchain for it.
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS mcp-builder
WORKDIR /mcp-server
COPY packages/mcp-server/package.json packages/mcp-server/package-lock.json* ./
RUN npm ci --prefer-offline --no-audit --no-fund
COPY packages/mcp-server/tsconfig.json ./
COPY packages/mcp-server/src ./src
RUN npm run build
# Result: /mcp-server/dist/ + /mcp-server/node_modules/.

# -----------------------------------------------------------------------------
# Stage 2 — the Hermes runtime image.
# -----------------------------------------------------------------------------
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEBIAN_FRONTEND=noninteractive

# --- System dependencies -----------------------------------------------------
# - tini           : PID-1 init that reaps the zombie children the MCP stdio
#                     subprocesses, git, node, etc. would otherwise leave.
# - git            : pip installs Hermes from a git ref.
# - build-essential, gcc, python3-dev, libffi-dev : native wheels in the
#                     Hermes dependency tree (pydantic-core, etc.).
# - ripgrep        : Hermes' file `search` tool shells out to `rg`.
# - ffmpeg         : voice/media tooling.
# - curl, ca-certificates : NodeSource setup + healthcheck.
# - procps         : the supervisor uses `pgrep`/process checks.
# - openssh-client : agents may `git`/`ssh` from the terminal tool.
# - iptables       : PR 4 of docs/codex-builder-runtime.md — the codex-builder
#                    profile's egress allowlist (scoped --uid-owner 10001) is
#                    installed at supervisor boot when ENABLE_CODEX_BUILDER=1.
#                    Dormant on every other tenant. Adds ~10 MB to the image.
# - dnsutils       : `dig` resolves OpenAI/GitHub/npm CIDR sets at boot for
#                    the iptables setup. Tiny (~5 MB).
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
        git \
        build-essential gcc python3-dev libffi-dev \
        ripgrep \
        ffmpeg \
        curl ca-certificates \
        procps \
        openssh-client \
        iptables \
        dnsutils \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js 22 (NodeSource) --------------------------------------------------
# Required so the Hermes gateway can spawn the 6 stdio MCP servers
# (ctrl-server.mjs + the 5-app bundle) as `node` child processes.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

# =============================================================================
# OpenAI Codex CLI — installed for use ONLY by the codex-builder profile.
# =============================================================================
# Available on PATH inside the container, but the codex-builder profile (PR 2)
# is the only one with credentials (CODEX_HOME) and an isolated workspace to
# act on. main/workers/heavy can `which codex` but a `codex exec` would 401
# (no auth file in their CODEX_HOME) and would have no workspace to mutate
# (their terminal.cwd is the profile dir, not /work).
#
# Source: npm @openai/codex. Pin a version arg so a future bump is explicit
# and reviewable. See docs/codex-builder-runtime.md §3 for the install
# rationale (image-size impact, separation of concerns, security model).
#
# PR 1 of 5 — Sir 2026-05-28. The CLI is INERT until PR 2 lands the profile
# config + supervisor entry. No existing profile's behaviour changes here.
ARG CODEX_CLI_REF=0.135.0
RUN npm install -g --no-audit --no-fund "@openai/codex@${CODEX_CLI_REF}" \
 && codex --version

# --- /etc/passwd entry for the codex-builder uid (10001) ----------------------
# Pre-create the uid that PR 2's supervisor.sh will drop the codex-builder
# gateway process onto via `setpriv --reuid 10001`. Without an entry,
# tools that stat the running uid's home dir (codex, ssh, git, npm) emit
# noisy "No passwd entry for user 10001" warnings even though they otherwise
# work — and a future Hermes hook that relies on `pwd.getpwuid(os.geteuid())`
# would crash on KeyError. Doing it in PR 1 keeps PR 2 focused on the profile
# rendering and supervisor wiring; the uid is unused until then.
#
# Home points at the profile state dir (laid down by PR 2's init container).
# Shell is /usr/sbin/nologin — the operator-facing surface for this uid is
# `docker exec -u 10001 ... bash`, NOT an interactive login.
RUN echo 'codex-builder:x:10001:10001::/hermes-state/profiles/codex-builder:/usr/sbin/nologin' \
    >> /etc/passwd \
 && echo 'codex-builder:x:10001:' >> /etc/group

# =============================================================================
# Install Hermes Agent from a PINNED upstream ref.
# =============================================================================
# Pinned to the v0.14.0 release tag (v2026.5.16). Hermes exact-pins every
# direct dependency in pyproject.toml (supply-chain hygiene after the Mini
# Shai-Hulud worm), so this install is reproducible without uv.lock.
#
# Extras chosen for a server runtime (NOT `[all]` — `[all]` pulls `[dev]`
# = pytest/ruff/ty, unwanted in production):
#   cron      — scheduled jobs (croniter is core; kept for completeness)
#   cli       — gateway/CLI menu deps
#   mcp       — MCP client (mcp==1.26.0) — REQUIRED for the 6 stdio servers
#   web       — fastapi + uvicorn — REQUIRED, the OpenAI-compatible API server
#   messaging — telegram / discord / slack adapters for the `main` profile's
#               channels
#   google    — Gmail/Calendar/Drive skill deps
#
# When bumping: update HERMES_VERSION here AND packages/hermes/VERSION, open a PR.
#
# 2026-07-02 (#hermes-017-fleet-bake): pinned to the 0.17.0 PyPI WHEEL, not the
# git ref. The wheel ships `web_dist` (the dashboard SPA bundle) which the
# `git+https` build omits — required for the supervised main-profile dashboard
# (see memory project_hermes_017_upgrade_canary + CLAUDE.md §9.3/§15.6). The four
# patch_upstream_* / patch_openai_sdk scripts below patch the same
# site-packages files regardless of install source (wheel lands in the same
# /usr/local/lib/python3.12/site-packages tree) and are tripwire'd, so a moved
# 0.17 symbol fails the build loudly rather than silently no-op'ing.
ARG HERMES_VERSION=0.19.0
# Pin the openai SDK to the version the golden home box runs (2.24.0). Hermes
# 0.17's openai floor lets pip float openai to a NEWER release that reintroduced
# the null-output loop (`for output in response.output:`) — the first canary
# builds resolved that buggy version (home, installed 2026-06-30, got the
# null-safe 2.24.0). Pinning reproduces home exactly AND makes the build
# reproducible regardless of openai's release cadence. The verify-only tripwire
# below still guards against a future bump reintroducing the bug.
ARG OPENAI_VERSION=2.24.0
RUN pip install --no-cache-dir \
        "hermes-agent[cron,cli,mcp,web,messaging,google]==${HERMES_VERSION}" \
        "openai==${OPENAI_VERSION}" \
    && hermes --version || true

# -----------------------------------------------------------------------------
# Extra runtime deps that the 0.17 wheel does NOT pull (empty `Required-by` on
# the golden home box) but that the relay / voice / native-app stack needs. These
# are the "other hotfixes that made it work" — hand-`pip install`ed on home during
# the 2026-06-29 canary. Pinned to the exact versions home runs so the fleet
# reproduces the proven-good environment. A build-time freeze diff (see
# debug/0702 spec §2.2) gates completeness against the home golden freeze.
#   local STT for relay voice ..... faster-whisper ctranslate2 onnxruntime av
#                                   tokenizers huggingface_hub hf-xet
#   QR pairing (`hermes pair`) .... segno
#   browser / desktop CDP tools ... playwright (pulls pyee + greenlet)
#   document + OCR ingest ......... PyMuPDF pypdf pytesseract python-docx
#                                   openpyxl reportlab pillow lxml
#                                   beautifulsoup4 Markdown
#   AWS (remote secret import) .... boto3
# NOTE: pytesseract needs the `tesseract-ocr` OS binary and playwright needs a
# browser binary for full function — canary verifies whether the relay/desktop
# tooling requires them locally or drives a remote CDP (browser_supervisor.py is
# a CDP client). Add apt/`playwright install` here only if the canary shows a gap.
RUN pip install --no-cache-dir \
        "faster-whisper==1.2.1" "ctranslate2==4.8.0" "onnxruntime==1.27.0" \
        "av==17.1.0" "tokenizers==0.23.1" "huggingface_hub==1.21.0" "hf-xet==1.5.1" \
        "segno==1.6.6" \
        "playwright==1.60.0" \
        "PyMuPDF==1.27.2.3" "pypdf==6.14.2" "pytesseract==0.3.13" \
        "python-docx==1.2.0" "openpyxl==3.1.5" "reportlab==5.0.0" "pillow==12.2.0" \
        "lxml==6.1.1" "beautifulsoup4==4.15.0" "Markdown==3.10.2" \
        "boto3==1.42.89" \
    && python3 -c "import faster_whisper, playwright, segno, fitz, pytesseract, docx, openpyxl, boto3; print('extra relay/voice/doc deps OK')"

# -----------------------------------------------------------------------------
# SVG rasterisation + ElevenLabs TTS. Same story as the block above: these were
# hand-`pip install`ed on home (into /root/.local, so `--force-recreate` would
# have silently dropped them) and never baked. Two shipped things import them:
#   cairosvg ..... hermes-agent's own tools/vision_tools.py
#   elevenlabs ... the shipped alfred-channel-delivery skill's voice-note path
# Without these a fresh deploy ships the skill and the tool but not the import,
# so both fail at first use rather than at build time. libcairo is already in
# the base layer (verified: `ldconfig -p | grep libcairo` → 2 entries), so this
# is pip-only. Pinned to the versions home runs.
RUN pip install --no-cache-dir \
        "cairosvg==2.9.0" "cairocffi==1.7.1" "cffi==2.1.1" "pycparser==3.0" \
        "cssselect2==0.9.0" "tinycss2==1.5.1" "webencodings==0.6.1" \
        "defusedxml==0.7.1" \
        "elevenlabs==1.59.0" \
    && python3 -c "import cairosvg, cairocffi, cssselect2, tinycss2, defusedxml, elevenlabs; print('svg/tts deps OK')"

# =============================================================================
# (removed 2026-08-05) The HTML-attachment patch (patch_upstream_hermes.py) is
# obsolete as of Hermes 0.19.0: upstream now ships .html/.htm in base.py's
# _TEXT_INJECT_EXTENSIONS (base.py:1446 comment acknowledges the exact gap),
# and the Slack adapter moved to plugins/platforms/slack/adapter.py consuming
# that shared set. The old script's docstring sanctioned dropping it "if
# upstream finally accepts HTML." The auth (#2) + fd-leak (#3) patches below
# still apply cleanly to 0.19 (verified) and are retained.

# =============================================================================
# Patch: handle response.output=None in the openai SDK's streaming parser.
# 2026-05-27 OpenAI changed Codex's streaming shape — response snapshots carry
# output=None instead of []. parse_response() then crashes with 'NoneType' is
# not iterable, taking down every Hermes-main turn on openai-codex. One-line
# fix: `for output in (response.output or []):`.
#
# STILL REQUIRED under 0.17 (canary-confirmed 2026-07-02): the openai SDK 2.24.0
# that Hermes 0.17 pins STILL ships the buggy `for output in response.output:`
# in stock form — the fix was NOT adopted upstream. (An earlier canary iteration
# wrongly assumed 0.17 made this obsolete; the golden home box merely had it
# patched already, so home looked "fixed". Restored here.) The script is
# idempotent (skips if already patched) + tripwire'd (fails loudly if the
# needle moves in a future SDK).
COPY packages/hermes/patch_openai_sdk.py /tmp/patch_openai_sdk.py
RUN python3 /tmp/patch_openai_sdk.py \
 && grep -q 'for output in (response.output or \[\]):' \
        /usr/local/lib/python3.12/site-packages/openai/lib/_parsing/_responses.py \
 && rm /tmp/patch_openai_sdk.py

# =============================================================================
# Patch: profile-dir-aware chmod in hermes_constants.secure_parent_dir (GH #119).
#
# STILL REQUIRED under 0.17, re-authored for the refactor (canary-confirmed
# 2026-07-02): 0.17 moved the auth-store parent-dir tighten out of
# hermes_cli/auth.py into hermes_constants.secure_parent_dir(), but it STILL
# `os.chmod(parent, 0o700)` — it only added a guard that refuses `/` and
# top-level dirs (#25821), which does NOT cover a profile dir like
# `/hermes-state/profiles/codex-builder` (4 path parts). So an auth-store save
# still resets the codex-builder profile dir (0o711, needed for the
# paperclip-hermes uid-1000 adapter to read .env for the gateway API_SERVER_KEY)
# back to 0o700 → next paperclip → :18793 dispatch 401s. The patch teaches
# secure_parent_dir to skip Hermes profile dirs (…/profiles/<name>); the #25821
# root/top-level guard is preserved. Single site → covers all auth-save callers.
# Idempotent (sentinel) + tripwire'd; needle verified byte-for-byte vs home 0.17.
COPY packages/hermes/patch_upstream_hermes_auth.py /tmp/patch_upstream_hermes_auth.py
RUN python3 /tmp/patch_upstream_hermes_auth.py \
 && grep -q "alfred-black: never chmod a Hermes profile dir" \
        /usr/local/lib/python3.12/site-packages/hermes_constants.py \
 && rm /tmp/patch_upstream_hermes_auth.py

# =============================================================================
# Patch: fd-safe atomic write in utils.py (GH #222).
#
# The codex-builder profile's gateway wedges with `[Errno 24] Too many open
# files`, leaving leaked `.channel_directory_*.tmp` descriptors behind. Once
# the soft nofile limit (1024) is exhausted, every socket/sqlite open fails —
# Slack `auth.test` drops, the kanban sqlite store reports "unable to open
# database file", and the gateway cascades into an unhealthy state.
#
# The leaked file name is produced by gateway/channel_directory.py's writer,
# which calls `atomic_json_write(...)` (refreshed every 5 min). But that
# function is leak-safe — the ACTUAL leak is in the shared helper
# utils.py:atomic_json_write (and atomic_yaml_write +
# atomic_roundtrip_yaml_update): `tempfile.mkstemp()` returns a *raw* fd that
# is only adopted by `with os.fdopen(fd, ...) as f:`. If `os.fdopen` itself
# raises (exactly the fd-pressure condition we hit), the raw fd leaks — the
# `except` unlinks the `.tmp` file but never `os.close(fd)`. Each failed write
# burns one more descriptor, accelerating exhaustion. The patch wraps the
# fd-open in a guard that closes the raw fd on failure — a strict improvement
# for every atomic-write consumer (auth.json, config.yaml, sessions.json),
# not just codex-builder.
#
# See patch_upstream_hermes_channeldir.py for the full rationale. The patch is
# idempotent + tripwire'd; a future HERMES_REF bump that rewrites the helper
# fails the build loudly via the grep below.
#
# Sir 2026-06-01 — durable fix for GH #222.
COPY packages/hermes/patch_upstream_hermes_channeldir.py /tmp/patch_upstream_hermes_channeldir.py
RUN python3 /tmp/patch_upstream_hermes_channeldir.py \
 && grep -q "alfred-black: fd-safe atomic write" \
        /usr/local/lib/python3.12/site-packages/utils.py \
 && grep -q "_alfred_fdopen_or_close" \
        /usr/local/lib/python3.12/site-packages/utils.py \
 && rm /tmp/patch_upstream_hermes_channeldir.py

# =============================================================================
# Hermes 0.20.4 — the runtime the fleet actually executes.  (2026-08-19)
# =============================================================================
# 0.20.x is git-only: there is no PyPI wheel. So the pip install above stays as
# the base layer (it resolves the Python dep tree and gives the patched
# site-packages copy), and the vendor installer overlays 0.20.4 into
# /usr/local/lib/hermes-agent — which ships its OWN venv and its OWN launchers
# in /usr/local/bin. Every `hermes` invocation therefore runs the 0.20.x tree.
#
# Three consequences, each of which bit us on home before being handled here:
#
#  1. web_dist. The git tree ships no dashboard bundle — that is the original
#     reason HERMES_VERSION was pinned to the wheel (see the note above). Left
#     alone, `hermes dashboard` attempts an npm build on FIRST RUN, inside a
#     container that may have no writable npm cache. Pre-build it exactly as
#     `hermes dashboard --skip-build` documents: `cd web && npm run build`.
#
#  2. The upstream patches. The 0.20.x launcher execs its own venv with
#     PYTHONPATH/PYTHONHOME unset, so the three site-packages patches above
#     never reach the code that actually runs. They are re-applied to the
#     0.20.x tree below. The tripwires are per-invocation, so a needle that
#     moves in a future bump still fails the build loudly instead of silently
#     no-op'ing. NB 0.20.4 has FOUR fd-open sites in utils.py, not the
#     historical three — the channeldir patch warns and patches all of them.
#
#  3. hermes-live. The live-voice gateway is a SEPARATE npm package, not part
#     of Hermes; the Hermes-side plugin only talks to it. The plugin half is
#     tenant state (it lives in the hermes volume), but the `hermes-live`
#     binary is an image artifact — so it vanishes on every container recreate
#     unless it is baked. Pinned to the version matching the plugin (0.9.5).
#
# --skip-browser / --skip-computer-use: the installer would otherwise pull
# ~620 MB of Playwright/Chromium that no fleet image has ever shipped (the base
# image installs the playwright *library* only). Skipping keeps fleet parity
# and keeps the image near 1 GB rather than 2.5 GB.
ARG HERMES_GIT_COMMIT=13ce0c5c675e843af70d19c9e5144249cd51c8d1
ARG HERMES_GIT_VERSION=0.20.4
ARG HERMES_LIVE_VERSION=0.9.5
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh \
 && npm_config_nodedir=/usr npm_config_unsafe_perm=true \
    bash /tmp/hermes-install.sh \
        --commit "${HERMES_GIT_COMMIT}" \
        --hermes-home /opt/data \
        --skip-setup --non-interactive --skip-browser --skip-computer-use \
 && rm -f /tmp/hermes-install.sh \
 && hermes --version \
 && hermes --version | grep -qF "v${HERMES_GIT_VERSION}"

# Pre-build the dashboard SPA so first run never shells out to npm (see 1).
RUN cd /usr/local/lib/hermes-agent/web \
 && npm_config_nodedir=/usr npm_config_unsafe_perm=true npm install --no-audit --no-fund \
 && npm run build \
 && test -f /usr/local/lib/hermes-agent/hermes_cli/web_dist/index.html \
 && npm cache clean --force

# Re-apply the three upstream patches to the 0.20.x tree (see 2).
COPY packages/hermes/patch_upstream_hermes_auth.py       /tmp/p_auth.py
COPY packages/hermes/patch_upstream_hermes_channeldir.py /tmp/p_chan.py
COPY packages/hermes/patch_openai_sdk.py                 /tmp/p_openai.py
RUN HT=/usr/local/lib/hermes-agent \
 && RESP="$(ls "$HT"/venv/lib/python*/site-packages/openai/lib/_parsing/_responses.py | head -1)" \
 && python3 /tmp/p_auth.py   "$HT/hermes_constants.py" \
 && python3 /tmp/p_chan.py   "$HT/utils.py" \
 && python3 /tmp/p_openai.py "$RESP" \
 && grep -qF "alfred-black: never chmod a Hermes profile dir" "$HT/hermes_constants.py" \
 && grep -qF "alfred-black: fd-safe atomic write"             "$HT/utils.py" \
 && grep -qF "_alfred_fdopen_or_close"                        "$HT/utils.py" \
 && grep -qF "(response.output or [])"                        "$RESP" \
 && "$HT/venv/bin/python" -m py_compile "$HT/hermes_constants.py" "$HT/utils.py" "$RESP" \
 && rm -f /tmp/p_auth.py /tmp/p_chan.py /tmp/p_openai.py

# The messaging adapters must live in the VENDOR VENV, not site-packages (see 2).
# `hermes-agent[...,messaging,...]` above installs slack_bolt / slack_sdk /
# python-telegram-bot / discord.py into /usr/local/lib/python3.12/site-packages.
# But /usr/local/bin/hermes unsets PYTHONPATH/PYTHONHOME and execs the 0.20.x
# venv (python3.11), which cannot see them. The adapter then fails to construct
# and the platform goes silently unavailable — the gateway still starts, every
# healthcheck still returns 200, and the only trace is three lines at boot:
#   WARNING gateway.platform_registry: Platform 'Slack' requirements not met
#   ERROR   gateway.run: Platform 'slack' is registered but adapter creation failed
#   WARNING gateway.run: No adapter available for slack
#
# 2026-08-19 -> 2026-08-24: a tenant's Slack assistant was mute for five days on
# exactly this. Its tokens were valid the whole time. Another tenant looked fine
# only because it had been hand-patched nine seconds after its container came up
# during the same rollout — an undocumented fix living in a container's writable
# layer, one `up -d` from vanishing.
#
# Versions are pinned to whatever the `messaging` extra resolved above so the two
# trees agree. The venv has no pip, no ensurepip, and uv is not on PATH, so these
# go in via the 3.12 pip with --target; all four are pure-Python.
#
# When bumping HERMES_GIT_VERSION: re-check this. Same class as the patch block
# above — anything site-packages needs, the vendor venv needs too.
RUN HT=/usr/local/lib/hermes-agent \
 && SP="$(ls -d "$HT"/venv/lib/python*/site-packages)" \
 && python3 -m pip install --no-cache-dir --target "$SP" \
        "slack_bolt==1.29.0" \
        "slack_sdk==3.43.0" \
        "python-telegram-bot==22.6" \
        "discord.py==2.7.1" \
 && "$HT/venv/bin/python" -c "import slack_bolt, slack_sdk, telegram, discord" \
 && echo "messaging adapters importable in vendor venv"

# The live-voice gateway binary (see 3). Off unless the live-voice compose
# profile is enabled; baking it costs ~44 MB and removes the recreate cliff.
RUN npm_config_nodedir=/usr npm_config_unsafe_perm=true \
    npm install --global --no-audit --no-fund "hermes-live-voice@${HERMES_LIVE_VERSION}" \
 && hermes-live --version | grep -qF "${HERMES_LIVE_VERSION}" \
 && npm cache clean --force

# =============================================================================
# Bake the hermes-lcm plugin (lossless cross-session context engine).
# =============================================================================
# The `stephenschoettler/hermes-lcm` plugin enables Hermes' LCM context engine
# for the user-facing main profile (lossless reload of prior session context,
# vs the default summariser). Pinned to upstream tag v0.11.1 — never `main` /
# no pin, so the build is reproducible and a supply-chain hijack of the
# upstream branch cannot land silently. The plugin lives at /opt/hermes-lcm
# in the image; supervisor.sh copies it into
# $HERMES_HOME/profiles/main/plugins/hermes-lcm at first boot (main only).
ARG HERMES_LCM_REF=2d108b759e33b72427350dffcb77281f7f61baf9
RUN git clone https://github.com/stephenschoettler/hermes-lcm /opt/hermes-lcm \
    && git -C /opt/hermes-lcm checkout "${HERMES_LCM_REF}" \
    && rm -rf /opt/hermes-lcm/.git

# =============================================================================
# Patch: LCMEngine.__deepcopy__ for Hermes 0.19 per-agent engine copying
# (upstream workaround, GH #424).
#
# Hermes 0.19 deep-copies the context engine into each delegated / spawned
# agent. The default deepcopy fails because LCMEngine's three store objects
# (MessageStore, SummaryDAG, LifecycleStateStore) each hold a live
# sqlite3.Connection as self._conn; LCMEngine also holds a threading.RLock
# and threading.local, which are equally unpicklable. Result: 331 WARNING
# log lines in 7 days on home — every sub-agent silently fell back to the
# built-in compressor instead of LCM. Main-profile conversation is unaffected.
#
# The patch adds __deepcopy__ to LCMEngine: it creates a fresh engine from
# the same config (re-opening new connections to the shared WAL-mode lcm.db)
# and copies only the mutable budget / counter scalars. Session-binding state
# is intentionally NOT carried — the sub-agent starts its own session.
#
# Applies against HERMES_LCM_REF 2d108b759e33b72427350dffcb77281f7f61baf9
# (tag v0.11.1). Re-verify NEEDLE in patch_lcm_deepcopy.py after bumping ref.
# The durable fix is upstreaming __deepcopy__ to stephenschoettler/hermes-lcm.
COPY packages/hermes/patch_lcm_deepcopy.py /tmp/patch_lcm_deepcopy.py
RUN python3 /tmp/patch_lcm_deepcopy.py \
 && grep -q "alfred-black: LCMEngine __deepcopy__" /opt/hermes-lcm/engine.py \
 && rm /tmp/patch_lcm_deepcopy.py

# =============================================================================
# Bake the `one-alfred` plugin (the user-facing continuity layer).
# =============================================================================
# Sir's principle: the user must feel they are talking to ONE Alfred, always.
# Hermes' main/workers/heavy profile split + per-session keying means a
# delegate-completion message lands in a synthetic session that main's actual
# Telegram session has no memory of. The one-alfred plugin closes that gap by
# (a) injecting ctrl-api's alfred_journal into main's inbound context via
# pre_gateway_dispatch, and (b) journalling Sir's replies + main's responses
# via pre_llm_call + post_llm_call. See packages/ctrl/docs/design/one-alfred.md.
#
# Lives at /opt/one-alfred in the image; supervisor.sh deploys it into
# $HERMES_HOME/profiles/main/plugins/one-alfred at first boot (main only —
# workers/heavy never speak to Sir directly so they don't need the bridge).
COPY packages/hermes/plugins/one-alfred /opt/one-alfred

# =============================================================================
# Bake the hermes-relay plugin (native-app bridge).
# =============================================================================
# Axiom Labs `Codename-11/hermes-relay` (manifest version 1.2.1). Provides QR
# pairing (`hermes pair`), relay sessions, android_* + desktop_* remote control,
# provider-native realtime voice, and dashboard management — the stack behind the
# Hermes native/Android app + voice on home.
#
# VENDORED (not git-cloned) because: (a) the repo has no `v1.2.1` tag — its
# release tags top out at v0.7.0 and the plugin's manifest `version` is a
# separate scheme, so there is no clean pinnable ref; (b) vendoring the exact
# tree the proven-good home box runs guarantees the fleet is byte-identical to
# the golden reference. Source captured from home.alfred.black on 2026-07-02
# (4.5M, 238 files, no node_modules). See packages/hermes/plugins/hermes-relay/
# VENDORED.md for provenance. Refresh by re-capturing from the golden box.
#
# Lives at /opt/hermes-relay in the image; supervisor.sh deploys it into
# $HERMES_HOME/profiles/main/plugins/hermes-relay at boot (main only) and creates
# the `plugin` import-shim symlink (the plugin uses absolute `plugin.*` imports
# but installs under hermes-relay/).
COPY packages/hermes/plugins/hermes-relay /opt/hermes-relay

# =============================================================================
# Bake @paperclipai/mcp-server (Paperclip's first-party MCP server).
# =============================================================================
# 48 first-party Paperclip tools (companies, employees, issues, projects,
# routines, approvals, …) wired through Paperclip's REST API. Published by
# paperclipai to npm; we pin a version-tagged release for reproducibility.
#
# This is a DELIBERATE divergence from the five-app stdio bundle convention
# (alfred/sure/plane/vaultwarden/execute live in packages/mcp-server). For
# Paperclip we use the upstream package directly because reimplementing 48
# tools is duplicative + every Paperclip release would mean re-curating the
# wrapper. Trade-off: voice-bridge won't have Paperclip tools yet (it
# connects to packages/mcp-server's HTTP surface only); follow-up PR can add
# a curated wrapper there if voice use-cases emerge. See plan: Paperclip P1,
# Sir 2026-05-26.
#
# Hermes loads this via the `paperclip` block in hermes-config.yaml.njk's
# mcp_servers list; PAPERCLIP_API_KEY (issued by Paperclip's better-auth UI
# — NOT auto-generated, see scripts/bootstrap.sh) and PAPERCLIP_API_URL are
# injected via env.
ARG PAPERCLIP_MCP_REF=2026.525.0
RUN mkdir -p /opt/paperclip-mcp \
 && npm install --prefix /opt/paperclip-mcp --no-audit --no-fund \
        "@paperclipai/mcp-server@${PAPERCLIP_MCP_REF}" \
 && test -f /opt/paperclip-mcp/node_modules/@paperclipai/mcp-server/dist/stdio.js

# =============================================================================
# Bake the MCP bundle.
# =============================================================================
# The 5-app stdio bundle + its node_modules, plus the ctrl-server.mjs HTTP
# proxy. Staged at /opt/mcp-stdio and /opt/mcp; the init container copies
# (rsyncs) these into each Hermes profile dir at first boot so they live on
# the persistent volume and can be hot-updated.
COPY --from=mcp-builder /mcp-server/dist          /opt/mcp-stdio/dist
COPY --from=mcp-builder /mcp-server/node_modules  /opt/mcp-stdio/node_modules
COPY packages/mcp-server/skills                   /opt/mcp-stdio/skills
COPY packages/mcp-server/package.json             /opt/mcp-stdio/package.json
COPY packages/hermes/mcp/ctrl-server.mjs          /opt/mcp/ctrl-server.mjs

# =============================================================================
# Bake skills + agent docs.
# =============================================================================
# - workspace-template/skills : platform-native Alfred skills (teach the
#   user-facing agent how to use its ctrl_* / MCP tools).
# - workspace-template/docs/TOOLS.md : the canonical capability reference.
# - AGENTS.md : the canonical executor instructions (same doc claude.ai's
#   Custom Connector loads).
# The init container deploys these into each Hermes profile dir; staging them
# in the image keeps the init container's job a pure copy.
COPY packages/hermes/workspace-template/skills     /opt/hermes-assets/skills
COPY packages/hermes/workspace-template/docs/TOOLS.md /opt/hermes-assets/TOOLS.md
COPY packages/mcp-server/instructions/alfred-custom-instructions.md /opt/hermes-assets/AGENTS.md

# =============================================================================
# Convenience CLI wrappers.
# =============================================================================
# `alfred chat` opens the main (user-facing) profile; `workers-cli` and
# `heavy-cli` cover the background/heavy profiles. Equivalent to
# `hermes -p <profile> "$@"`. These complement the sticky default set by
# supervisor.sh (`hermes profile use main`) so BOTH styles work:
#   - bare `hermes chat`        — sticky default
#   - explicit `alfred chat`    — wrapper
# The workers/heavy wrappers are suffixed `-cli` to avoid any clash with
# present-or-future binaries named plainly `workers` / `heavy`. `alfred` is
# safe — no existing `alfred` binary in the runtime image.
RUN printf '#!/bin/sh\nexec hermes -p main "$@"\n' > /usr/local/bin/alfred && \
    printf '#!/bin/sh\nexec hermes -p workers "$@"\n' > /usr/local/bin/workers-cli && \
    printf '#!/bin/sh\nexec hermes -p heavy "$@"\n' > /usr/local/bin/heavy-cli && \
    chmod +x /usr/local/bin/alfred /usr/local/bin/workers-cli /usr/local/bin/heavy-cli

# =============================================================================
# codex-builder profile helpers (PR 4 of docs/codex-builder-runtime.md).
# =============================================================================
# Two scripts the codex-builder profile needs at runtime:
#
#   setup-egress-jail.sh — iptables OUTPUT chain scoped --uid-owner 10001,
#     allowlists OpenAI/GitHub/npm/PyPI/crates.io, REJECTs everything else.
#     Called by the supervisor at boot when ENABLE_CODEX_BUILDER=1.
#
#   codex-builder-prep-run.sh — invoked by the codex-builder agent at run
#     start. Creates /work/runs/<runId>/repo as a fresh `git clone` and
#     checks out a feature branch. Returns the workspace path on stdout.
#     Defensive on runId/issueId — refuses path traversal, refuses to
#     overwrite an existing run dir (collisions = bug).
#
# Both are baked into /usr/local/bin so they're on the codex-builder
# gateway's PATH and the existing 3 profiles can ignore them.
#
# PR 5 adds codex-builder-run.sh — the wrapper the codex-builder agent
# invokes per-run. Takes (runId, issueId, promptFile), shells out to
# `codex exec`, commits + pushes, writes /work/runs/<runId>/audit.json,
# emits a JSON envelope on stdout.
COPY packages/hermes/docker/setup-egress-jail.sh /usr/local/bin/codex-builder-setup-egress.sh
COPY packages/hermes/docker/codex-builder-prep-run.sh /usr/local/bin/codex-builder-prep-run.sh
COPY packages/hermes/docker/codex-builder-run.sh /usr/local/bin/codex-builder-run.sh
RUN chmod +x /usr/local/bin/codex-builder-setup-egress.sh \
             /usr/local/bin/codex-builder-prep-run.sh \
             /usr/local/bin/codex-builder-run.sh

# codex-builder profile persona — `SOUL.md` Hermes loads per-profile.
# This is the agent identity Sir's Paperclip persona references. The
# init container copies it into the profile dir (PR 5).
COPY packages/hermes/SOUL.codex-builder.md /opt/hermes-assets/SOUL.codex-builder.md
# Nightly session-retention job, installed into workers/heavy by supervisor.sh.
COPY packages/hermes/scripts/state_retention.py /opt/hermes-assets/state_retention.py

# =============================================================================
# Self-render renderer scripts (#120 Lane IIb).
# =============================================================================
# When ctrl-api registers a new user-facing profile AFTER init has exited,
# the supervisor's SIGUSR1 reconciler needs to render that profile dir
# inline — no operator step, no init re-run. We bake the SAME two renderer
# scripts the init container runs (render_hermes.py + render_mcp_servers.py)
# plus the two .njk templates into the runtime image, so the runtime self-
# render is byte-identical to a boot-time render.
#
# jinja2 + ruamel.yaml are required by render_hermes.py (template render)
# and render_mcp_servers.py (round-trip YAML mutator). pinned to the same
# versions the init image uses for byte-stable output across re-renders.
#
# render_registry.py is NOT baked here — supervisor reads the registry JSON
# ctrl-api already wrote (no state.db mount in the hermes runtime).
RUN pip install --no-cache-dir "jinja2==3.1.6" "ruamel.yaml==0.18.6"

# edge-tts — text-to-speech (Microsoft Edge online voices) used by the voice
# surface. Previously pip-installed by hand into running hermes containers
# (observed hot-installed on zsolt 2026-06), so it vanished on every image
# redeploy. Baked here so it survives recreates. `edge-playback` ships in the
# same package. Pinned to the version that was running in the field.
RUN pip install --no-cache-dir "edge-tts==7.2.7"
COPY packages/hermes/init/render_hermes.py       /opt/hermes-init/render_hermes.py
COPY packages/hermes/init/render_mcp_servers.py  /opt/hermes-init/render_mcp_servers.py
COPY packages/hermes/hermes-config.yaml.njk      /opt/hermes-init/templates/hermes-config.yaml.njk
COPY packages/hermes/hermes-profile.env.njk      /opt/hermes-init/templates/hermes-profile.env.njk
RUN chmod 0755 /opt/hermes-init/render_hermes.py /opt/hermes-init/render_mcp_servers.py

# =============================================================================
# Supervisor entrypoint.
# =============================================================================
COPY packages/hermes/docker/supervisor.sh /opt/hermes-supervisor/supervisor.sh
RUN chmod +x /opt/hermes-supervisor/supervisor.sh

# Hermes resolves all profile state under HERMES_HOME. /opt/data is the
# mounted volume (named volume `hermes_data` in docker-compose). Profiles
# live at ${HERMES_HOME}/profiles/{main,workers}/.
ENV HERMES_HOME=/opt/data \
    HERMES_ASSETS_DIR=/opt/hermes-assets \
    HERMES_MCP_STDIO_SRC=/opt/mcp-stdio \
    HERMES_MCP_CTRL_SRC=/opt/mcp/ctrl-server.mjs

# Hermes API server ports — the gateways bind these directly (the shim that
# used to front them was retired in issue #40). This is the contract every
# caller speaks: the Hermes /v1 API on :18789 (main) / :18790 (workers).
EXPOSE 18789 18790

# Healthcheck probes BOTH gateways' /health endpoints — main :18789
# (chat/onboarding) AND workers :18790 (clerk/background). A green healthcheck
# means both real Hermes runtimes are up; a dead workers gateway must keep the
# container UNhealthy so dependents don't start against a dead clerk gateway.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
    CMD curl -fsS http://localhost:18789/health && curl -fsS http://localhost:18790/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/hermes-supervisor/supervisor.sh"]
