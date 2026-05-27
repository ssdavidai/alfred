/**
 * Hermes Agent adapter for Paperclip — HTTP-mode fork.
 *
 * Public top-level exports (matches upstream's `index.ts` surface).
 */

import { ADAPTER_TYPE, ADAPTER_LABEL } from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * In HTTP mode the model list comes from Hermes config.yaml — Paperclip
 * cannot influence it. We surface an empty list so the Paperclip UI shows
 * "managed by Hermes" instead of a curated set the operator might think
 * is authoritative.
 */
export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# Hermes Agent (HTTP mode) — Configuration

This is the alfred-black local fork of \`hermes-paperclip-adapter\`. It
calls the tenant's existing Hermes Agent container over HTTP instead of
spawning a \`hermes\` CLI inside the paperclip container.

## How it works

Every heartbeat:

1. Renders a wake-up prompt from \`promptTemplate\` (Mustache-lite syntax).
2. POSTs the prompt to \`{HERMES_GATEWAY_URL}/v1/responses\` with
   \`X-Hermes-Session-Key: paperclip-<agentId>\`.
3. Surfaces the assistant text + token usage back to Paperclip.

Hermes' own message history (keyed by session-key) handles continuity
across heartbeats. No \`--resume\`, no CLI args.

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| hermesGatewayUrl | string | http://hermes:18789 | Hermes main gateway base URL. Falls back to \`HERMES_GATEWAY_URL\` env var. |
| timeoutSec | number | 300 | Per-call timeout (seconds). |
| sessionKey | string | (derived) | Pin a specific Hermes session key. Default is \`paperclip-<agentId>\`. |
| promptTemplate | string | (built-in) | Custom wake-up prompt. Mustache-lite: \`{{var}}\` + \`{{#section}}…{{/section}}\`. |

## Available Template Variables

- \`{{agentId}}\` — Paperclip agent ID
- \`{{agentName}}\` — Agent display name
- \`{{companyId}}\` — Paperclip company ID
- \`{{companyName}}\` — Company display name
- \`{{runId}}\` — Current heartbeat run ID
- \`{{taskId}}\` / \`{{taskTitle}}\` / \`{{taskBody}}\` — Task fields (when assigned)
- \`{{commentId}}\` — Comment ID (when triggered by a comment)
- \`{{wakeReason}}\` — Why this heartbeat fired
- \`{{projectName}}\` — Project name (when scoped to a project)

## What's NOT honoured (vs upstream CLI mode)

Model, provider, toolsets, verbose, worktreeMode, checkpoints, extraArgs —
all owned by Hermes' \`config.yaml\` per the principal's operator-owned
configuration. Setting them in Paperclip has no effect in HTTP mode.

## Authentication

The adapter reads Hermes' \`API_SERVER_KEY\` from
\`/hermes-state/profiles/main/.env\` at call time. The paperclip container
must mount \`hermes_data:/hermes-state:ro\` for this to work.
`;
