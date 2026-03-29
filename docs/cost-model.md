# Alfred Black — LLM Cost Model

## How to use this model

Plug in your numbers in the **Input Variables** section. The formulas calculate total tokens and cost across all agents.

---

## Input Variables (change these)

| Variable | Symbol | Default | Description |
|----------|--------|---------|-------------|
| Inbox files per day | `F` | 5 | PDFs, docs, transcripts dropped into vault inbox |
| Gmail emails per day | `E` | 30 | Emails fetched via Gmail stream |
| Chat messages per day | `M` | 50 | Messages exchanged with Alfred via OpenClaw |
| Zoom transcripts per day | `Z` | 1 | 30-min zoom = ~6,000 words = ~8,000 tokens |
| Omi ambient transcripts per day | `O` | 3 | Each ~5-10 min of audio = ~2,000 tokens |
| Webhook events per day | `W` | 5 | GitHub, Polar, Slack, etc. |
| Vault size (total records) | `V` | 200 | Grows over time. Affects context size. |
| Queued errands per day | `T` | 2 | Tasks Alfred executes autonomously |
| Average entities per inbox file | `N` | 3 | People, projects, decisions extracted per file |
| Average words per email | `We` | 150 | ~200 tokens per email |
| Average words per chat message | `Wm` | 40 | ~55 tokens per message |
| Average Zoom transcript words | `Wz` | 6000 | 30 min meeting ≈ 6,000 words ≈ 8,000 tokens |
| Average Omi segment words | `Wo` | 1500 | 5-10 min ambient ≈ 1,500 words ≈ 2,000 tokens |

---

## Token Formulas Per Agent

### 1. Curator (processes inbox files)

Each inbox file triggers Stage 1 (analyze) + Stage 4 (enrich per entity).

| Call | Count per day | Input tokens | Output tokens |
|------|--------------|-------------|--------------|
| S1 Analyze | `F + Z + O` | `(2000 + 500 + min(V×5, 3000) + file_tokens) × count` | `3000 × count` |
| S4 Enrich | `(F + Z + O) × N` | `(1300 + file_tokens) × count` | `1500 × count` |

Where:
- `file_tokens` for inbox files = ~1,000 (average document)
- `file_tokens` for Zoom = `Wz × 1.3` ≈ 8,000
- `file_tokens` for Omi = `Wo × 1.3` ≈ 2,000
- `vault_context` = `min(V × 5, 3000)` tokens (grows with vault size)

**Formulas:**
```
curator_s1_calls = F + Z + O
curator_s1_input = curator_s1_calls × (2500 + min(V×5, 3000)) + F×1000 + Z×8000 + O×2000
curator_s1_output = curator_s1_calls × 3000

curator_s4_calls = (F + Z + O) × N
curator_s4_input = curator_s4_calls × 2800
curator_s4_output = curator_s4_calls × 1500
```

### 2. Clerk (classifies stream events)

Every stream event (emails, webhooks, chat flushes, Omi segments) gets classified.

| Call | Count per day | Input tokens | Output tokens |
|------|--------------|-------------|--------------|
| Classify | `E + W + chat_flushes + O` | `(600 + event_tokens) × count` | `400 × count` |
| Braindump extract | `~1 per day` | `4000` | `2000` |

Where:
- `event_tokens` for email = `We × 1.3` ≈ 200
- `event_tokens` for webhook = ~300
- `event_tokens` for chat flush = ~500 (accumulated messages)
- `chat_flushes` = `M / 10` (chat hook flushes every 10 messages)
- `event_tokens` for Omi = `Wo × 1.3` ≈ 2,000

**Formulas:**
```
classify_calls = E + W + floor(M/10) + O
classify_input = E×800 + W×900 + floor(M/10)×1100 + O×2600
classify_output = classify_calls × 400
```

### 3. Janitor (repairs vault structure)

Runs once per day (deep sweep). Calls depend on vault quality, not input volume.

| Call | Count per day | Input tokens | Output tokens |
|------|--------------|-------------|--------------|
| S2 Link repair | `max(0, V×0.02)` | `1800 × count` | `750 × count` |
| S3 Enrich stubs | `max(0, V×0.01)` | `4000 × count` | `2000 × count` |

**Formulas:**
```
janitor_s2_calls = ceil(V × 0.02)  // ~2% of records have broken links
janitor_s2_input = janitor_s2_calls × 1800
janitor_s2_output = janitor_s2_calls × 750

janitor_s3_calls = ceil(V × 0.01)  // ~1% are stubs
janitor_s3_input = janitor_s3_calls × 4000
janitor_s3_output = janitor_s3_calls × 2000
```

### 4. Distiller (extracts learnings — weekly, amortized daily)

| Call | Count per day (amortized) | Input tokens | Output tokens |
|------|--------------------------|-------------|--------------|
| S1 Extract | `min(V×0.05, 20) / 7` | `5000 × count` | `2000 × count` |
| S3 Create | `count × 0.6` | `2500 × count` | `2000 × count` |
| Pass B Meta | `clusters / 7` | `4500 × count` | `3000 × count` |

Where `clusters` ≈ `V / 50` (one cluster per ~50 records)

**Formulas:**
```
distiller_s1_calls = min(V × 0.05, 20) / 7
distiller_s3_calls = distiller_s1_calls × 0.6
distiller_pb_calls = ceil(V / 50) / 7

distiller_input = distiller_s1_calls×5000 + distiller_s3_calls×2500 + distiller_pb_calls×4500
distiller_output = distiller_s1_calls×2000 + distiller_s3_calls×2000 + distiller_pb_calls×3000
```

### 5. Session Tracker

| Call | Count per day | Input tokens | Output tokens |
|------|--------------|-------------|--------------|
| Boundary/topic | `floor(M/20)` | `1000 × count` | `200 × count` |

### 6. Daily Digest

| Call | Count per day | Input tokens | Output tokens |
|------|--------------|-------------|--------------|
| Digest | 1 | `2500 + min(V×2, 3000)` | `1000` |

### 7. Reflection (nightly)

| Call | Count per day | Input tokens | Output tokens |
|------|--------------|-------------|--------------|
| Reflect | 1 | `3000 + instincts×200 + observations×150` | `2000` |

Where `instincts` grows over time (0 at start, ~20 after month 1, ~50 mature), `observations` = daily observations (~5-10).

### 8. Task Runner

| Call | Count per day | Input tokens | Output tokens |
|------|--------------|-------------|--------------|
| Execute | `T` | `3000 × T` | `1000 × T` |
| Consequentials | `T` | `2000 × T` | `400 × T` |

### 9. Surveyor (embedding — NOT LLM)

Surveyor uses **embedding API** (text-embedding-3-small), not chat completion. Much cheaper.

| Call | Count per day | Input tokens | Cost per 1M |
|------|--------------|-------------|-------------|
| Embed new records | `F + Z + O + (E×0.3)` | `500 × count` | $0.02 (OpenAI) |
| Cluster labeling (LLM) | `ceil(V/50) / 7` | `2000 × count` | Same as chat model |

---

## Scenario Calculator

### Scenario A: Light User (solo founder, email only)
```
F=2, E=20, M=20, Z=0, O=0, W=3, V=200, T=1, N=3
```

| Agent | Calls | Input | Output |
|-------|------:|------:|-------:|
| Curator | 2+6=8 | 28K | 13K |
| Clerk Classify | 25 | 22K | 10K |
| Janitor | 6 | 19K | 9K |
| Distiller | 2 | 9K | 4K |
| Session | 1 | 1K | 0.2K |
| Digest | 1 | 3K | 1K |
| Reflect | 1 | 4K | 2K |
| Tasks | 2 | 5K | 1.4K |
| **TOTAL** | **46** | **91K** | **41K** |

**Monthly: 2.7M input + 1.2M output**

| Model | Monthly Cost |
|-------|----------:|
| grok-4.1-fast ($0.20/$0.50) | **$1.14** |
| gpt-4.1-mini ($0.40/$1.60) | **$3.00** |
| claude-haiku-4.5 ($0.80/$4.00) | **$6.96** |

---

### Scenario B: Power User (founder, Gmail + Zoom + Omi + active chat)
```
F=5, E=50, M=100, Z=2, O=5, V=500, T=3, N=4
```

| Agent | Calls | Input | Output |
|-------|------:|------:|-------:|
| Curator | 12+48=60 | 176K | 108K |
| Clerk Classify | 72 | 106K | 29K |
| Janitor | 15 | 63K | 27K |
| Distiller | 5 | 21K | 10K |
| Session | 5 | 5K | 1K |
| Digest | 1 | 4K | 1K |
| Reflect | 1 | 5K | 2K |
| Tasks | 6 | 15K | 4K |
| **TOTAL** | **165** | **395K** | **182K** |

**Monthly: 11.8M input + 5.5M output**

| Model | Monthly Cost |
|-------|----------:|
| grok-4.1-fast | **$5.11** |
| gpt-4.1-mini | **$13.52** |
| claude-haiku-4.5 | **$31.44** |

---

### Scenario C: Month 1 Onboarding Burst (3,000 emails initial sync)
```
F=100/day for 5 days (converting 500 emails to inbox), E=3000 over 5 days,
Z=0, O=0, M=10, W=0, V growing from 0→2000, T=0, N=3
```

| Phase | Calls | Input | Output |
|-------|------:|------:|-------:|
| Email classification (3,000) | 3,000 | 2.4M | 1.2M |
| Curator S1 (500 files) | 500 | 3.5M | 1.5M |
| Curator S4 (1,500 entities) | 1,500 | 4.2M | 2.3M |
| Janitor (2,000 records) | 60 | 168K | 63K |
| Distiller (2,000 records) | 200 | 875K | 520K |
| **BURST TOTAL** | **5,260** | **11.1M** | **5.6M** |

| Model | Onboarding Burst Cost |
|-------|----------:|
| grok-4.1-fast | **$5.02** |
| gpt-4.1-mini | **$13.40** |
| claude-haiku-4.5 | **$30.88** |

---

### Scenario D: Heavy User (team lead, all integrations, lots of meetings)
```
F=10, E=80, M=200, Z=4, O=10, W=15, V=2000, T=5, N=5
```

| Agent | Calls | Input | Output |
|-------|------:|------:|-------:|
| Curator | 24+120=144 | 440K | 252K |
| Clerk Classify | 125 | 225K | 50K |
| Janitor | 60 | 204K | 87K |
| Distiller | 10 | 43K | 21K |
| Session | 10 | 10K | 2K |
| Digest | 1 | 7K | 1K |
| Reflect | 1 | 7K | 2K |
| Tasks | 10 | 25K | 7K |
| **TOTAL** | **361** | **961K** | **422K** |

**Monthly: 28.8M input + 12.7M output**

| Model | Monthly Cost |
|-------|----------:|
| grok-4.1-fast | **$12.11** |
| gpt-4.1-mini | **$31.84** |
| claude-haiku-4.5 | **$74.04** |

---

## Tiered Model Strategy (Recommended)

Use different models for different tasks based on quality needs:

| Tier | Tasks | Recommended Model | Monthly Cost (Scenario B) |
|------|-------|------------------|------------------------:|
| **Cheap** | Classify, Session, Judgment | grok-4.1-fast | $2.10 |
| **Mid** | Curator, Janitor, Distiller, Learning, Reflect | gpt-4.1-mini or haiku | $8.50 |
| **Premium** | Task execution, First Brief, Daily Digest | claude-sonnet | $3.20 |
| **TIERED TOTAL** | | | **$13.80** |

vs. single model: grok-4.1-fast = $5.11, haiku = $31.44

---

## Key Scaling Factors

| Factor | Impact on tokens | Why |
|--------|-----------------|-----|
| **Vault size (V)** | +5 tokens per record in curator context, +2% janitor calls | Curator S1 sends vault directory listing. Janitor scales with vault. |
| **Emails per day (E)** | +800 input tokens per email | Each email = 1 classify call. Not curator-processed unless promoted. |
| **Zoom transcripts (Z)** | +11,000 input tokens per transcript | Large documents. Curator S1 + S4 × N entities. Most expensive per-item. |
| **Omi segments (O)** | +4,600 input tokens per segment | Moderate size. Both curator + classify. |
| **Chat volume (M)** | +110 input per message (flushed in batches of 10) | Chat flushes become stream events for classify. |
| **Entities per file (N)** | ×2,800 input per extra entity | Curator S4 fires once per entity. Biggest multiplier. |

## Optimization Levers

| Optimization | Token Savings | Effort |
|-------------|--------------|--------|
| Batch entity enrichment (send all N in one prompt) | -40% curator S4 | Medium |
| Deterministic noise filter (skip CI emails) | -20% classify | Easy |
| Truncate email body to 500 tokens | -30% classify | Easy |
| Cache vault context across batch | -15% curator S1 | Medium |
| Skip janitor for recently-created records | -50% janitor | Easy |
| Reduce distiller to monthly deep sweep | -75% distiller | Config change |
