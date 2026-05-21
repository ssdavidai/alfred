# Changing models — Hermes runbook

Hermes is the **sole agent runtime**: every LLM call in the system goes through
it. The live model for each kind of work is owned by Hermes — set it with the
Hermes CLI on the running container, **not** by editing `.env`.

> `HERMES_MAIN_MODEL` / `HERMES_WORKERS_MODEL` / `HERMES_HEAVY_MODEL` in `.env`
> are only the **first-boot seed**. `config.yaml` is rendered seed-only-if-absent,
> so on a running box editing `.env` does nothing — the CLI is the only live lever.

## The three profiles

| Profile | Drives | Seeded default | Gateway |
|---|---|---|---|
| `main` | the conversational / chat agent (channels + memory) | `x-ai/grok-4.3` | `:18789` |
| `workers` | clerk, surveyor labeling, reflection — cheap background | `openai/gpt-4.1-nano` | `:18790` |
| `heavy` | onboarding + chore heavy-reasoning | `anthropic/claude-opus-4-6` | `:18791` |

Callers route by gateway port + an `X-Hermes-Session-Key` agent id and send **no
model** in the request — the profile's config owns it. So changing a profile's
model changes it for every task on that profile.

## Change a model

1. Get on the Hermes container:
   ```bash
   ssh root@<box>
   docker exec -it alfred-black-hermes-1 bash
   ```

2. Set the model with the **nested `model.default` key** (per profile):
   ```bash
   hermes -p heavy   config set model.default anthropic/claude-sonnet-4-6
   hermes -p main    config set model.default x-ai/grok-4.3
   hermes -p workers config set model.default openai/gpt-4.1-nano
   ```

   > ⚠️ **Use `model.default`, never bare `model`.**
   > `hermes config set model <id>` overwrites the whole block with a bare
   > string and **drops `provider: openrouter` + `base_url`**, which breaks
   > routing. `model.default` edits only the model and keeps the provider.
   > The value must be an **OpenRouter model id** (the provider stays
   > `openrouter`). See https://openrouter.ai/models.

3. Apply it — restart so the running gateways reload their `config.yaml`:
   ```bash
   exit                            # back to the host
   docker compose restart hermes   # relaunches all 3 gateways; each re-reads config.yaml
   ```
   (`hermes gateway restart` is for systemd/launchd installs; our Docker
   supervisor runs the gateways in the foreground, so a container restart is the
   reliable apply step. Do not assume a live hot-reload.)

4. Verify:
   ```bash
   docker exec alfred-black-hermes-1 hermes -p heavy config show | grep -iA1 'Model:'
   ```

## Notes

- **Persists across restarts and redeploys.** `config.yaml` lives on the
  `hermes_data` volume; the init renderer is seed-only-if-absent and logs
  `preserved (operator-owned)` — it never clobbers your change.
- **Switching provider (not just the model id)** — e.g. to a Nous-portal OAuth
  model or direct Anthropic — use the interactive picker `hermes -p <profile>
  model`, or set `model.provider` + `model.base_url` alongside `model.default`.
- **Provider credentials** live only in Hermes (`hermes auth add` / `hermes
  login`; seeded from `.env` on first boot). The `alfred` and `alfred-learn`
  containers carry no provider keys.
- **Other knobs, same pattern:** `hermes -p <profile> config show` (read),
  `hermes -p <profile> config edit` (open in `$EDITOR` for multiple edits).
- **Not routed through Hermes (by design):** `voice-bridge` (OpenAI Realtime
  websocket — not a Hermes-able call; not in the default compose stack).
