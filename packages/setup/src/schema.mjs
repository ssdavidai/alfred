// schema.mjs — the declarative field schema for the alfred-black .env.
//
// This array is the single source of truth the wizard walks. It mirrors the
// variable list, ordering, and comments of /work/.env.example. Three blocks:
//
//   required   — USER MUST FILL — required (bootstrap.sh refuses without these)
//   optional   — USER MUST FILL — optional (blank disables the feature)
//   generated  — AUTO-GENERATED — randomBytes(32).toString('hex')
//
// Field descriptor shape:
//   key       env var name
//   block     'required' | 'optional' | 'generated'
//   label     short prompt label
//   help      help text shown to the user (mirrors .env.example comments)
//   type      'input' | 'password' | 'confirm' | 'model' | 'auto'
//   default   default value (string; for confirm: 'true' | 'false')
//   comment   the comment block emitted above the var in the written .env
//   validate  optional sync validator: (value) => true | 'error string'
//   when      optional gate: (answers) => boolean — only prompt if true

const isDomain = (v) =>
  /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/.test(v);
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

export const FIELDS = [
  // ── USER MUST FILL — required ─────────────────────────────────────
  {
    key: 'DOMAIN',
    block: 'required',
    label: 'Apex domain',
    type: 'input',
    help:
      'The apex domain alfred-black is served on. The web app lives at\n' +
      'https://${DOMAIN}; sidecars at plane./sure./vault./mcp.${DOMAIN}.\n' +
      'Point A-records for @ api plane sure vault mcp at this VM before `up`.',
    comment:
      '# The apex domain alfred-black is served on. The web app lives at\n' +
      '# https://${DOMAIN}; sidecars at plane./sure./vault./mcp.${DOMAIN}.\n' +
      '# Point A-records for @ plane sure vault mcp at this VM before `up`.',
    validate: (v) =>
      isDomain(v.trim()) || 'That does not look like a domain (e.g. example.com).',
  },
  {
    key: 'ACME_EMAIL',
    block: 'required',
    label: "Let's Encrypt contact email",
    type: 'input',
    help: 'Contact email for Let\'s Encrypt certificate registration.',
    comment: '# Contact email for Let\'s Encrypt certificate registration.',
    validate: (v) =>
      isEmail(v.trim()) || 'That does not look like an email address.',
  },
  {
    key: 'OWNER_NAME',
    block: 'required',
    label: "Principal's display name",
    type: 'input',
    help: "The principal's display name (shown across the dashboard).",
    comment: "# The principal's display name (shown across the dashboard).",
    validate: (v) => v.trim().length > 0 || 'A name is required.',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    // .env.example lists this in the required block, but bootstrap.sh treats
    // it as optional ("Hermes routes LLM traffic through OpenRouter by
    // default"). The wizard follows bootstrap.sh: optional, validated if set.
    block: 'required',
    optionalOverride: true,
    label: 'Anthropic API key (optional — direct Anthropic route)',
    type: 'password',
    help:
      'Anthropic API key — optional. Hermes routes LLM traffic through\n' +
      'OpenRouter by default; set this only for a direct Anthropic route.',
    comment: '# Anthropic API key — the primary model provider.',
  },
  {
    key: 'OPENROUTER_API_KEY',
    block: 'required',
    label: 'OpenRouter API key',
    type: 'password',
    help: 'OpenRouter API key — primary model routing for Hermes.',
    comment: '# OpenRouter API key — fallback / secondary model routing.',
    validate: (v) => v.trim().length > 0 || 'OpenRouter API key is required.',
  },
  {
    key: 'COMPOSIO_API_KEY',
    block: 'required',
    label: 'Composio API key',
    type: 'password',
    help: 'Composio API key — third-party tool/integration connections.',
    comment: '# Composio API key — third-party tool/integration connections.',
    validate: (v) => v.trim().length > 0 || 'Composio API key is required.',
  },

  // ── USER MUST FILL — optional ─────────────────────────────────────
  {
    key: 'HERMES_MAIN_MODEL',
    block: 'optional',
    label: 'Hermes main model (user-facing chat)',
    type: 'model',
    default: 'x-ai/grok-4.3',
    help:
      'Bare OpenRouter model ID for the user-facing chat model.\n' +
      'Default x-ai/grok-4.3.',
    comment:
      '# Hermes LLM models — bare OpenRouter model IDs (see openrouter.ai/models).\n' +
      '# Defaults are sane current picks; override if a model ID goes stale or you\n' +
      '# want a different one. main = user-facing chat; workers = background agents.',
  },
  {
    key: 'HERMES_WORKERS_MODEL',
    block: 'optional',
    label: 'Hermes workers model (background agents)',
    type: 'model',
    default: 'openai/gpt-4.1-nano',
    help: 'Bare OpenRouter model ID for background-agent work.\n' +
      'Default openai/gpt-4.1-nano.',
    comment: null, // grouped under HERMES_MAIN_MODEL's comment
  },
  {
    key: 'GOOGLE_CLIENT_ID',
    block: 'optional',
    label: 'Google OAuth client ID',
    type: 'input',
    default: '',
    help:
      'Google OAuth — TWO roles:\n' +
      '  1. "Sign in with Google" on the web app (cosmetic).\n' +
      '  2. REQUIRED for automatic onboarding (Gmail backfill + profiling).\n' +
      'Create a Web-application OAuth client at console.cloud.google.com.',
    comment:
      '# Google OAuth — TWO roles:\n' +
      '#   1. "Sign in with Google" on the web app (cosmetic — email+password works\n' +
      '#      without it).\n' +
      '#   2. REQUIRED for automatic onboarding. After signup the owner clicks\n' +
      '#      "Start onboarding", which connects Gmail (gmail.readonly scope) so\n' +
      '#      Alfred can backfill ~100 days of email and build the behavioural\n' +
      '#      profile. With these blank, the "Start onboarding" flow has nothing to\n' +
      '#      connect to and onboarding cannot run.\n' +
      '# Create a Web-application OAuth client at console.cloud.google.com; add the\n' +
      '# redirect URI  https://api.${DOMAIN}/auth/google/callback  and the\n' +
      '# gmail.readonly scope.',
  },
  {
    key: 'GOOGLE_CLIENT_SECRET',
    block: 'optional',
    label: 'Google OAuth client secret',
    type: 'password',
    default: '',
    help: 'The client secret paired with the Google OAuth client ID above.',
    comment: null,
  },
  {
    key: 'SENDGRID_API_KEY',
    block: 'optional',
    label: 'SendGrid API key',
    type: 'password',
    default: '',
    help:
      'SendGrid API key — transactional email (verification, password reset).\n' +
      'Leave blank to disable email sending (signup still works via dev mode).',
    comment:
      '# SendGrid API key — transactional email (verification, password reset).\n' +
      '# Leave blank to disable email sending (signup still works via dev mode).',
  },
  {
    key: 'MAILGUN_API_KEY',
    block: 'optional',
    label: 'Mailgun API key',
    type: 'password',
    default: 'placeholder-set-a-real-key-to-send-email',
    help:
      "Mailgun — the web app's configured email provider. The app boots even\n" +
      'with placeholder values, but verification / password-reset emails only\n' +
      'deliver with a real key + domain. Get them at mailgun.com.',
    comment:
      "# Mailgun — the web app's configured email provider. The app boots even\n" +
      '# with placeholder values here, but verification / password-reset emails\n' +
      '# only deliver with a real key + domain. Get them at mailgun.com.',
  },
  {
    key: 'MAILGUN_DOMAIN',
    block: 'optional',
    label: 'Mailgun sending domain',
    type: 'input',
    default: 'new.alfred.black',
    help: 'The Mailgun domain mail is sent from.',
    comment: null,
  },
  {
    key: 'SURE_ENABLED',
    block: 'optional',
    label: 'Enable Sure (personal finance)',
    type: 'confirm',
    default: 'true',
    help:
      'Sure (personal finance) runs in the default stack. Set false only if\n' +
      'you also remove the sure-* services from docker-compose.yaml.',
    comment:
      '# Sure (personal finance) runs in the default stack. Its first-boot admin\n' +
      '# account is staged for the ACME_EMAIL address. Set false only if you also\n' +
      '# remove the sure-* services from docker-compose.yaml.',
  },
  {
    key: 'VEXA_ENABLED',
    block: 'optional',
    label: 'Enable Vexa (meeting-transcription) stack',
    type: 'confirm',
    default: 'false',
    help:
      'Set true to run the Vexa transcript-bot stack. You must also start it\n' +
      'with the profile: `docker compose --profile vexa up -d`.',
    comment:
      '# Set to true to run the Vexa transcript-bot stack. You must also start it\n' +
      '# with the profile: `docker compose --profile vexa up -d`.',
  },
  {
    key: 'ALFRED_OWNER_EMAIL',
    block: 'optional',
    label: "Principal's primary email (Vexa / email routing)",
    type: 'input',
    default: '',
    help:
      "The principal's primary email address — used by Vexa meeting intake\n" +
      'and email-channel routing. Optional unless VEXA_ENABLED=true.',
    comment:
      "# The principal's primary email address — used by Vexa meeting intake and\n" +
      '# email-channel routing. Optional unless VEXA_ENABLED=true.',
    when: (a) => a.VEXA_ENABLED === 'true',
    validate: (v) =>
      v.trim() === '' || isEmail(v.trim()) || 'That does not look like an email address.',
  },
  {
    key: 'VEXA_TRANSCRIPTION_URL',
    block: 'optional',
    label: 'Vexa transcription backend URL',
    type: 'input',
    default: 'https://api.groq.com/openai/v1/audio/transcriptions',
    help:
      'Vexa transcription backend (Groq Whisper by default). Only needed\n' +
      'when VEXA_ENABLED=true.',
    comment:
      '# Vexa transcription backend (Groq Whisper by default). Only needed when\n' +
      '# VEXA_ENABLED=true.',
    when: (a) => a.VEXA_ENABLED === 'true',
  },
  {
    key: 'VEXA_TRANSCRIPTION_TOKEN',
    block: 'optional',
    label: 'Vexa transcription backend token',
    type: 'password',
    default: '',
    help: 'API token for the Vexa transcription backend.',
    comment: null,
    when: (a) => a.VEXA_ENABLED === 'true',
  },

  // ── AUTO-GENERATED — managed by the wizard (was bootstrap.sh) ──────
  // randomBytes(32).toString('hex'); never overwrites an existing value.
  {
    key: 'AAS_API_KEY',
    block: 'generated',
    comment: '# ctrl-api bearer key — shared between web → ctrl-api and mcp-server.',
  },
  {
    key: 'COLUMN_ENCRYPTION_KEY',
    block: 'generated',
    comment: '# AES-256-GCM key for OAuthCredential token encryption at rest.',
  },
  {
    key: 'JWT_SECRET',
    block: 'generated',
    comment: '# Wasp session JWT signing secret.',
  },
  {
    key: 'HERMES_API_SERVER_KEY',
    block: 'generated',
    comment: '# Hermes gateway API-server key (both profiles share this token).',
  },
  {
    key: 'WEB_DATABASE_PASSWORD',
    block: 'generated',
    comment: '# Postgres password for the Wasp web app database (web-db).',
  },
  {
    key: 'VAULTWARDEN_ADMIN_TOKEN',
    block: 'generated',
    comment: '# Vaultwarden /admin token.',
  },
  {
    key: 'VAULTWARDEN_BW_PASSWORD',
    block: 'generated',
    comment: '# Vaultwarden bw-cli unlock password.',
  },
  {
    key: 'MCP_APPROVAL_SECRET',
    block: 'generated',
    comment: '# mcp-server tool-approval signing secret.',
  },
  {
    key: 'DJANGO_SECRET_KEY',
    block: 'generated',
    comment: '# Plane — Django secret, datastore credentials, live-server secret.',
  },
  { key: 'POSTGRES_PASSWORD', block: 'generated', comment: null },
  { key: 'REDIS_PASSWORD', block: 'generated', comment: null },
  { key: 'MINIO_ROOT_PASSWORD', block: 'generated', comment: null },
  { key: 'LIVE_SERVER_SECRET_KEY', block: 'generated', comment: null },
  {
    key: 'SURE_SECRET_KEY_BASE',
    block: 'generated',
    comment: '# Sure — Rails secret + datastore credentials.',
  },
  { key: 'SURE_POSTGRES_PASSWORD', block: 'generated', comment: null },
  { key: 'SURE_REDIS_PASSWORD', block: 'generated', comment: null },
  {
    key: 'VEXA_POSTGRES_PASSWORD',
    block: 'generated',
    comment:
      '# Vexa — datastore credentials + internal API secrets (only used with the\n' +
      '# `vexa` profile, but generated unconditionally so the profile just works).',
  },
  { key: 'VEXA_MINIO_PASSWORD', block: 'generated', comment: null },
  { key: 'VEXA_ADMIN_API_TOKEN', block: 'generated', comment: null },
  { key: 'VEXA_INTERNAL_API_SECRET', block: 'generated', comment: null },
];

// Required keys the wizard hard-blocks on (mirrors bootstrap.sh REQUIRED[]).
export const HARD_REQUIRED = [
  'DOMAIN',
  'ACME_EMAIL',
  'OWNER_NAME',
  'OPENROUTER_API_KEY',
  'COMPOSIO_API_KEY',
];

export const GENERATED_KEYS = FIELDS.filter((f) => f.block === 'generated').map(
  (f) => f.key
);
