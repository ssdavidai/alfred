/**
 * `detectModel()` — upstream reads `~/.hermes/config.yaml`. We don't have
 * that file in the paperclip container, AND we don't want the principal
 * to see "Hermes is using anthropic/claude-sonnet-4" as if Paperclip
 * could override it — model selection is operator-owned via the Hermes
 * config.yaml. Return `null` so Paperclip's UI hides the "detected
 * model" affordance entirely.
 *
 * Follow-up: if Hermes ever surfaces `GET /v1/models` (it doesn't
 * today), we can wire that in here.
 */

export async function detectModel(
  _configPath?: string,
): Promise<{ model: string; provider: string; source: string } | null> {
  return null;
}

export function parseModelFromConfig(
  _content: string,
): { model: string; provider: string; source: string } | null {
  return null;
}
