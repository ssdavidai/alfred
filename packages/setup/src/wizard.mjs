#!/usr/bin/env node
// wizard.mjs — interactive onboarding wizard for alfred-black.
//
// Replaces the manual `cp .env.example .env && nano .env && ./scripts/
// bootstrap.sh` step with one interactive command. Reads/writes /work/.env
// (the host repo dir is bind-mounted at /work). Safely re-runnable: doubles
// as a config editor.
//
//   node src/wizard.mjs
//
// Live key validation:
//   OPENROUTER_API_KEY — HARD-BLOCKING (must be 200, or re-prompt)
//   COMPOSIO_API_KEY   — warn-only except a clear 401/403 (hard fail)
//   ANTHROPIC_API_KEY  — warn-only except a clear 401/403 (hard fail)
// Network errors are never fatal — they degrade to a warning.

import {
  input,
  password,
  select,
  confirm,
  search,
} from '@inquirer/prompts';
import { randomBytes } from 'node:crypto';
import pc from 'picocolors';

import { FIELDS, HARD_REQUIRED, GENERATED_KEYS } from './schema.mjs';
import { parseEnv, writeEnv } from './envfile.mjs';
import {
  validateOpenRouter,
  validateAnthropic,
  validateComposio,
} from './validators.mjs';

const ENV_PATH = '/work/.env';

const gen = () => randomBytes(32).toString('hex');

function banner() {
  console.log('');
  console.log(pc.bold(pc.cyan('  alfred-black — setup wizard')));
  console.log(
    pc.dim('  Collects keys, validates them live, picks models, generates')
  );
  console.log(pc.dim('  secrets, and writes .env. Re-run any time to edit.'));
  console.log('');
}

function showHelp(field) {
  if (!field.help) return;
  console.log('');
  for (const line of field.help.split('\n')) {
    console.log(pc.dim('  ' + line));
  }
}

// ── prompt a single non-key field ───────────────────────────────────
async function promptPlain(field, current) {
  showHelp(field);
  const def = current ?? field.default ?? '';

  if (field.type === 'confirm') {
    const ans = await confirm({
      message: field.label,
      default: (def || 'false') === 'true',
    });
    return ans ? 'true' : 'false';
  }

  const opts = {
    message: field.label,
    default: def || undefined,
    validate: field.validate
      ? (v) => {
          // optional fields accept empty
          if (
            (v ?? '').trim() === '' &&
            (field.block === 'optional' || field.optionalOverride)
          ) {
            return true;
          }
          return field.validate(v ?? '');
        }
      : undefined,
  };

  const ans =
    field.type === 'password' ? await password({ ...opts, mask: '•' }) : await input(opts);
  return (ans ?? '').trim();
}

// ── prompt + live-validate an API key ───────────────────────────────
// `validator` returns { ok: true|false|'warn', ... }. true/'warn' accept;
// false re-prompts.
async function promptKey(field, current, validator, { optional }) {
  let extra = {};
  while (true) {
    showHelp(field);
    const def = current ?? field.default ?? '';
    const value = (
      await password({ message: field.label, mask: '•', default: def || undefined })
    ).trim();

    if (value === '') {
      if (optional) {
        console.log(pc.yellow('  (skipped)'));
        return { value: '', extra };
      }
      console.log(pc.red('  This field is required.'));
      continue;
    }

    process.stdout.write(pc.dim('  verifying… '));
    const result = await validator(value);

    if (result.ok === true) {
      console.log(pc.green('✓ ' + (result.detail || 'verified')));
      return { value, extra: result };
    }
    if (result.ok === 'warn') {
      console.log(pc.yellow('⚠ ' + result.warning));
      return { value, extra: result };
    }
    // hard fail — re-prompt
    console.log(pc.red('✗ ' + result.error));
    console.log(pc.dim('  Please re-enter the key.'));
    extra = result;
  }
}

// ── model selection from the OpenRouter list ────────────────────────
async function promptModel(field, current, models) {
  showHelp(field);
  const def = current || field.default;

  if (!models || models.length === 0) {
    console.log(
      pc.yellow('  (OpenRouter model list unavailable — free-text entry)')
    );
    return (await input({ message: field.label, default: def })).trim() || def;
  }

  const chosen = await search({
    message: field.label,
    source: async (term) => {
      const t = (term || '').toLowerCase();
      const matched = models.filter((m) => m.toLowerCase().includes(t));
      const list = (t ? matched : models).slice(0, 40);
      // keep the default reachable even if it is not in the live list
      if (!models.includes(def) && (!t || def.toLowerCase().includes(t))) {
        list.unshift(def);
      }
      return list.map((m) => ({
        name: m === def ? `${m}  ${pc.dim('(default)')}` : m,
        value: m,
      }));
    },
  });
  return chosen;
}

async function main() {
  banner();

  // ── existing-config detection ─────────────────────────────────────
  const existing = parseEnv(ENV_PATH);
  const hasExisting = Object.keys(existing).length > 0;
  let prefill = {};

  if (hasExisting) {
    console.log(pc.bold(`  An existing ${ENV_PATH} was found.`));
    const mode = await select({
      message: 'How would you like to proceed?',
      choices: [
        {
          name: 'Edit existing values (prompts pre-filled with current values)',
          value: 'edit',
        },
        { name: 'Start fresh (ignore the existing .env)', value: 'fresh' },
      ],
    });
    if (mode === 'edit') prefill = existing;
    console.log('');
  }

  const answers = {};
  let openRouterModels = [];

  // ── walk the schema ───────────────────────────────────────────────
  for (const field of FIELDS) {
    if (field.block === 'generated') continue;
    if (field.when && !field.when(answers)) {
      // skipped feature field — keep any prefill value, else default/blank
      answers[field.key] = prefill[field.key] ?? field.default ?? '';
      continue;
    }

    const current = prefill[field.key];

    if (field.key === 'OPENROUTER_API_KEY') {
      const { value, extra } = await promptKey(field, current, validateOpenRouter, {
        optional: false,
      });
      answers[field.key] = value;
      if (extra.models?.length) openRouterModels = extra.models;
      continue;
    }
    if (field.key === 'ANTHROPIC_API_KEY') {
      const { value } = await promptKey(field, current, validateAnthropic, {
        optional: true,
      });
      answers[field.key] = value;
      continue;
    }
    if (field.key === 'COMPOSIO_API_KEY') {
      const { value } = await promptKey(field, current, validateComposio, {
        optional: false,
      });
      answers[field.key] = value;
      continue;
    }
    if (field.type === 'model') {
      answers[field.key] = await promptModel(field, current, openRouterModels);
      continue;
    }

    answers[field.key] = await promptPlain(field, current);
  }

  // ── Google OAuth follow-up ────────────────────────────────────────
  if (answers.GOOGLE_CLIENT_ID && answers.GOOGLE_CLIENT_SECRET) {
    console.log('');
    console.log(pc.bold('  Google OAuth — register this exact redirect URI:'));
    console.log(
      pc.cyan(`    https://api.${answers.DOMAIN}/auth/google/callback`)
    );
    console.log(pc.dim('  Add it to the OAuth client and grant the gmail.readonly scope.'));
  } else {
    console.log('');
    console.log(
      pc.yellow(
        '  ⚠ Google OAuth not configured. Automatic onboarding (Gmail backfill'
      )
    );
    console.log(
      pc.yellow(
        '    + behavioural profiling) will not be available. You can re-run'
      )
    );
    console.log(pc.yellow('    this wizard later to add it.'));
  }

  // ── hard-required guard (mirrors bootstrap.sh) ────────────────────
  const missing = HARD_REQUIRED.filter((k) => !(answers[k] ?? '').trim());
  if (missing.length) {
    console.log('');
    console.log(pc.red('  ERROR: required field(s) are still empty:'));
    for (const k of missing) console.log(pc.red('    - ' + k));
    process.exit(1);
  }

  // ── auto-generated secrets (idempotent) ───────────────────────────
  let generated = 0;
  let kept = 0;
  for (const key of GENERATED_KEYS) {
    const prior = (prefill[key] ?? '').trim();
    if (prior) {
      answers[key] = prior;
      kept++;
    } else {
      answers[key] = gen();
      generated++;
    }
  }

  // ── write ─────────────────────────────────────────────────────────
  writeEnv(ENV_PATH, answers);

  // ── summary ───────────────────────────────────────────────────────
  console.log('');
  console.log(pc.green(pc.bold('  ✓ .env written.')));
  console.log('');
  console.log(pc.bold('  Summary'));
  console.log(`    Domain            ${pc.cyan(answers.DOMAIN)}`);
  console.log(`    Owner             ${answers.OWNER_NAME}`);
  console.log(`    Main model        ${answers.HERMES_MAIN_MODEL}`);
  console.log(`    Workers model     ${answers.HERMES_WORKERS_MODEL}`);
  const feat = (label, on) =>
    `    ${label.padEnd(18)}${on ? pc.green('on') : pc.dim('off')}`;
  console.log(feat('Anthropic direct', !!answers.ANTHROPIC_API_KEY));
  console.log(
    feat('Google OAuth', !!(answers.GOOGLE_CLIENT_ID && answers.GOOGLE_CLIENT_SECRET))
  );
  console.log(
    feat(
      'Mailgun email',
      !!answers.MAILGUN_API_KEY &&
        answers.MAILGUN_API_KEY !== 'placeholder-set-a-real-key-to-send-email'
    )
  );
  console.log(feat('SendGrid email', !!answers.SENDGRID_API_KEY));
  console.log(feat('Sure (finance)', answers.SURE_ENABLED === 'true'));
  console.log(
    `    Secrets           ${generated} generated, ${kept} kept`
  );
  console.log('');
  console.log(pc.bold('  Next step:'));
  console.log(pc.cyan('    docker compose up -d'));
  console.log('');
}

main().catch((err) => {
  // @inquirer throws ExitPromptError on Ctrl-C — exit quietly.
  if (err && (err.name === 'ExitPromptError' || err.code === 'ERR_USE_AFTER_CLOSE')) {
    console.log('\n' + pc.yellow('  Cancelled — no changes written.'));
    process.exit(130);
  }
  console.error('\n' + pc.red('  Wizard error: ' + (err?.stack || err)));
  process.exit(1);
});
