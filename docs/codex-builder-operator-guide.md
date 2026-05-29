# codex-builder — operator guide

Day-to-day ops for the codex-builder sealed runtime
(docs/codex-builder-runtime.md). For the design, read that doc first.
For the build history: PRs #100, #101, #102, #103, #104, #105.

## Status / quick checks

```
# Profile dir present and gateway up?
docker exec alfred-black-hermes-1 ls /hermes-state/profiles/codex-builder/
docker exec alfred-black-hermes-1 curl -fsS http://localhost:18793/health

# Gateway running as the right uid?
docker exec alfred-black-hermes-1 ps -ef | grep 'p codex-builder'
# expect a uid 10001 line, NOT root or 10000

# Egress allowlist installed?
docker exec alfred-black-hermes-1 iptables -L OUTPUT -n | grep CODEX | head -5

# Adapter routing wired?
docker exec alfred-black-paperclip-1 node -e '
const m = require("/app/node_modules/.pnpm/hermes-paperclip-adapter@0.2.0/node_modules/hermes-paperclip-adapter/dist/server/execute.js");
console.log("codex-feature-builder ->", m.pickGatewayUrlForAgent({name:"codex-feature-builder", id:"", companyId:"", adapterType:"", adapterConfig:{}}, {}));
'
# expect {"gatewayUrl":"http://hermes:18793","profile":"codex-builder"}
```

## Initial bootstrap (one-time per tenant)

1. **Generate a deploy key pair** on a trusted machine:

   ```
   ssh-keygen -t ed25519 -f codex_id_ed25519 -C "codex-feature-builder@<tenant>" -N ""
   ```

2. **Register the public half** on github.com/ssdavidai/alfred:
   * Settings → Deploy keys → Add deploy key
   * Title: `codex-feature-builder-<tenant>`
   * Key: paste `codex_id_ed25519.pub`
   * **Allow write access:** YES
   * Click "Add key"

3. **Store the private half** in Vaultwarden under the alfred-black
   org → "deploy keys" collection. Type: SSH key. Notes: which tenant
   it's for + the GitHub deploy-key id (you'll need it to revoke).

4. **Mirror the private key into /opt/alfred/.env as base64**:

   ```
   echo "CODEX_BUILDER_DEPLOY_KEY_B64=$(base64 -w0 codex_id_ed25519)" \
     >> /opt/alfred/.env
   ```

5. **Flip the flag** (home only for v1):

   ```
   echo 'ENABLE_CODEX_BUILDER=true' >> /opt/alfred/.env
   ```

6. **Apply.** Pull the latest images + recreate init + hermes:

   ```
   cd /opt/alfred
   docker compose pull init hermes paperclip
   docker compose up -d --force-recreate init hermes paperclip
   ```

7. **Verify branch protection** on github.com/ssdavidai/alfred:
   * Settings → Branches → `main` → branch protection rule
   * Require a pull request before merging: YES
   * Do not allow bypassing the above settings: YES (so a compromised
     deploy key cannot force-push to main)

8. **Verify isolation** (run the §8.6 spot-checks from the design doc):

   ```
   docker exec -u 10001 -it alfred-black-hermes-1 bash
   > cat /vault/SOUL.md                              # Permission denied
   > cat /alfred-data/.gateway-token                 # Permission denied
   > cat /hermes-state/profiles/main/.env            # Permission denied
   > curl -m 5 -fsS https://api.anthropic.com/...    # Network unreachable
   > curl -m 5 -fsS https://api.openai.com/v1/models # 401 (no auth)
   > curl -m 5 -fsS https://example.com              # Network unreachable
   > cat /hermes-state/profiles/codex-builder/.env   # OK (own file)
   > ls /work                                        # OK (own dir)
   ```

## Auth (the shared-with-main contract)

Sir's decision #1 (docs/codex-builder-runtime.md §11.1): codex-builder
uses the SHARED openai-codex auth from Hermes-main. The supervisor's
auth-mirror block copies `main/auth.json` to two paths in the
codex-builder profile:
* `/hermes-state/profiles/codex-builder/auth.json` — Hermes' LLM-
  provider auth
* `/hermes-state/profiles/codex-builder/.codex/auth.json` — the codex
  CLI's auth at `$CODEX_HOME`

When main's auth.json is missing/stale, run on the tenant:

```
docker exec -it -u 10000 alfred-black-hermes-1 hermes -p main auth login
# Follow the ChatGPT device-auth prompt
docker compose restart hermes
# Supervisor's mirror block runs at boot and propagates
```

## A real run, step by step

```
# (1) Sir files a Paperclip issue, assigns to codex-feature-builder.
#     Paperclip's heartbeat reaches our adapter, the adapter routes
#     to :18793 (codex-builder profile).

# (2) Hermes-codex-builder agent invokes its terminal tool.
#     SOUL.md tells it: "Mint a runId, call codex-builder-prep-run.sh,
#     write the prompt, call codex-builder-run.sh, return the JSON
#     envelope". See packages/hermes/SOUL.codex-builder.md.

# (3) Watch the run in real-time:
docker logs alfred-black-hermes-1 --tail 100 -f | grep codex-builder

# (4) Once done, the branch is on github.com:
docker exec -u 10001 alfred-black-hermes-1 \
    ls /work/runs/ | tail -3
# expect: 20260528T210000Z-abcd1234 (or similar)

docker exec -u 10001 alfred-black-hermes-1 \
    cat /work/runs/<runId>/audit.json
# expect: { "ok": true, "branch": "codex/<issueId>-...", "pushed": true, ... }

# (5) On GitHub, the branch exists. Sir reviews + merges manually.
gh pr create --head codex/<issueId>-<sha7> --title "..." --body "..."
```

## Failure modes & recovery

| Symptom | Diagnosis | Recovery |
|---|---|---|
| Heartbeat returns 401 on :18793 | profile dir not rendered | check `docker logs alfred-black-init-1 \| grep codex-builder`; ensure ENABLE_CODEX_BUILDER=true; re-run init |
| `[supervisor] FATAL: codex-builder egress jail setup failed` | NET_ADMIN missing | check docker-compose.yaml hermes service `cap_add: NET_ADMIN`; rsync compose to tenant |
| `[init] [codex-builder] FAIL: uid 10001 can read /vault/SOUL.md` | FS isolation broken | check `/vault` is `0700 10000:10000`; step 7 chown ran |
| `git push failed` in audit | network blip OR auth | check egress: `docker exec alfred-black-hermes-1 iptables -L OUTPUT -n \| grep CODEX`; check deploy key: `docker exec alfred-black-hermes-1 ls -la /hermes-state/profiles/codex-builder/.ssh/` |
| `codex auth expired` in audit | OAuth token revoked / expired | re-run `hermes -p main auth login` on the tenant; restart hermes for the mirror |
| Workspace fills `/work` | per-run GC not catching up | manually: `docker exec -u 10001 alfred-black-hermes-1 find /work/runs -type d -mtime +1 -exec rm -rf {} +` |
| Codex runs but makes no changes | spec was infeasible / already done | this is by design — Sir reopens the issue with a clarified spec |
| Branch protection allowed force-push to main | repo settings drift | restore branch protection on github.com immediately; rotate the deploy key (it's still scoped to ssdavidai/alfred but the audit trail needs a fresh identity) |

## Extending the egress allowlist

Edit
`/hermes-state/profiles/codex-builder/network-allowlist.txt` on the
tenant:

```
# One hostname per line.
my-private-registry.internal.example
proxy.corp.example
```

Restart hermes:

```
docker compose restart hermes
```

The egress-jail script re-reads the file and adds ACCEPT rules for
the new hosts (resolved via dig at boot).

## Disabling

* Per tenant: `sed -i 's/^ENABLE_CODEX_BUILDER=.*/ENABLE_CODEX_BUILDER=false/' /opt/alfred/.env && docker compose up -d --force-recreate hermes`
* Fleet-wide rollback (revert the build): roll the hermes + init images back to the pre-PR-5 tag.

## Rotation rituals

* **Deploy key:** generate a new pair → register on github (replacing the old one) → update `CODEX_BUILDER_DEPLOY_KEY_B64` in /opt/alfred/.env → `docker compose up -d --force-recreate init hermes`. Old key is automatically replaced on next init boot.
* **codex CLI bump:** see `[[codex-builder-pr1-cli-installed]]` — update `ARG CODEX_CLI_REF=...` in packages/hermes/Dockerfile, PR, build-hermes rolls.
* **ChatGPT account:** swap the OAuth token by re-running `hermes -p main auth login` against the new account; restart hermes; supervisor's mirror block propagates.


## Codex CLI authentication (one-time per tenant)

Hermes-main and the codex CLI use **different OAuth schemas** even though both
authenticate against ChatGPT Plus/Pro. Hermes-main's `auth.json` (Hermes-shape,
2-token: access + refresh) **does not satisfy** the codex CLI, which needs the
full 4-token shape (id_token + access_token + refresh_token + account_id).
Mirroring Hermes's auth.json into `~/.codex/auth.json` looks superficially
correct but `codex doctor` will report:

  ✗ auth   stored credentials are incomplete

So a separate one-time `codex login` ritual is required, scoped to the
codex-builder profile:

```
docker exec -it --user codex-builder \
  -e HOME=/hermes-state/profiles/codex-builder \
  alfred-black-hermes-1 \
  codex login --device-auth
```

This prints a URL + code. Open the URL in any browser, approve on ChatGPT,
return to the terminal. The CLI writes a complete
`/hermes-state/profiles/codex-builder/.codex/auth.json`.

After that, `codex login status` returns "Logged in using ChatGPT" AND `codex
doctor` reports `✓ auth`.

> **Do NOT run `hermes auth login`** as previously documented — that refreshes
> Hermes's own auth.json (the chat path), which is a separate concern and is
> typically already valid.

<!-- codex-feature-builder smoke ok 2026-05-29 -->
