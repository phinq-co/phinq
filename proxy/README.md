# phinq-proxy

OpenRouter-compatible governance proxy for autonomous AI agents. Sits between
your agent and OpenRouter, inspects every model response for tool calls before
the agent sees them, and (from component 3 onward) holds high-risk actions
pending operator confirmation.

**Current state: feature-complete MVP (components 1–5) — shadow by default.**
Every tool call is deterministically classified (ALLOW or HOLD) and recorded
in a local JSONL corpus. With enforcement ON and Telegram configured, a HOLD
parks the entire response, sends you an Approve/Deny message, and the agent
only receives the response if you approve — deny or timeout returns a clean
synthetic denial the agent can continue from. Default remains **shadow mode**
(decisions logged, nothing held) until you've replayed a day of real traffic
to zero false HOLDs. See `../PROXY-MVP.md` for the build plan and
`DAY0-FINDINGS.md` for the measured client constraints that shaped the
defaults.

## Run

```bash
npm install
npm run dev          # tsx watch, port 5100
# or
npm run build && npm start
# or
docker build -t phinq-proxy . && docker run -p 5100:5100 phinq-proxy
```

## Point your agent at it

One-line change. For Hermes (`~/.hermes/config.yaml`):

```yaml
model:
  base_url: http://127.0.0.1:5100/api/v1   # was https://openrouter.ai/api/v1
```

Your OpenRouter API key keeps flowing through the `Authorization` header —
the proxy never stores or logs it.

### Codex CLI (Responses API)

The proxy is agent-agnostic — it also governs the OpenAI **Responses API**
(`/responses`), which Codex (≥0.142) uses via `wire_api = "responses"`. Point a
Codex provider at the proxy; no change to your real `~/.codex` is needed (pass
overrides with `-c`, or set a clean `CODEX_HOME`):

```toml
model_provider = "phinq"
model = "openai/gpt-oss-120b"          # any model your upstream serves

[model_providers.phinq]
name = "Phinq"
base_url = "http://127.0.0.1:5100/v1"  # Codex posts to /v1/responses
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
```

The proxy parses tool calls out of the Responses `output[]` array (function
calls, `local_shell_call`s, and any other `*_call` item) and runs them through
the same classifier, corpus, audit chain, **and holds** as the chat path. This
requires an upstream that speaks Responses — **OpenRouter does**. Streaming
Responses are buffered, inspected, then relayed.

Enforcement works on this path: a HOLD verdict pauses the response until the
operator approves or denies (`phinq approve/deny <id>`, or Telegram). On
approve, Codex receives the original action; on deny/timeout it receives a
Responses-shaped denial (a message with no tool call), so the withheld action
never executes. Verified end-to-end: Codex's `cat .env` → HOLD/CREDENTIAL_ACCESS
→ deny → the secret never reaches the agent; approve → it runs.

Also verified on the **OpenAI Agents SDK** (same Responses path, zero extra
code): point its client at the proxy —
`AsyncOpenAI(base_url="http://127.0.0.1:5100/v1", api_key=…)` +
`set_default_openai_client(client)` + `set_default_openai_api("responses")`.

### Anthropic SDK (Messages API)

The proxy also governs the Anthropic **Messages API** (`/v1/messages`) — the
Anthropic SDK and Claude-native agents. Point the SDK's `base_url` at the proxy;
Anthropic auth (`x-api-key`) is forwarded as-is:

```python
client = anthropic.Anthropic(base_url="http://127.0.0.1:5100", api_key=ANTHROPIC_API_KEY)
```

`/v1/messages` forwards to the Anthropic upstream (`PHINQ_ANTHROPIC_UPSTREAM`,
default `https://api.anthropic.com`) — **not** OpenRouter — so it needs a real
Anthropic key. Tool calls are parsed from the message `content[]` (`tool_use`
blocks, with streamed `input_json_delta`s reassembled), then run through the
same classifier, holds, and audit. Deny returns a Messages-shaped denial (a
text block, `stop_reason: "end_turn"`, no `tool_use`).

### Streaming

The proxy requires `stream:false`. Streaming requests get a 400 whose error
message deliberately matches Hermes's fallback predicate ("stream" +
"not supported"), so Hermes switches itself to non-streaming for the session
after one failed attempt. Other OpenAI-SDK agents: set `stream=False`.

### Hold windows (matters from component 4 onward)

Stock Hermes kills non-streaming connections after **300s** (its stale
detector — not the HTTP timeout). The proxy's hold timeout therefore defaults
to 240s. If you want 10-minute confirmation windows, raise the agent-side
limit in `~/.hermes/config.yaml`:

```yaml
providers:
  openrouter:
    stale_timeout_seconds: 660
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PHINQ_PORT` | `5100` | Listen port |
| `PHINQ_HOST` | `127.0.0.1` | Bind address (Docker image sets `0.0.0.0`) |
| `PHINQ_UPSTREAM` | `https://openrouter.ai` | Upstream origin |
| `PHINQ_UPSTREAM_TIMEOUT_MS` | `280000` | Upstream request timeout (kept under the agent's 300s) |
| `PHINQ_TOOLCALL_LOG` | `phinq-toolcalls.jsonl` | JSONL corpus of observed tool calls; set to `""` to disable |
| `PHINQ_CONFIG` | `phinq.yaml` | Classifier overrides (missing file = defaults) |
| `PHINQ_SESSION_DB` | `phinq-session.db` | SQLite file for session velocity counters (`:memory:` for ephemeral) |
| `PHINQ_HOLD_DB` | `phinq-holds.db` | SQLite file for held responses |
| `PHINQ_AUDIT_LOG` | `phinq-audit.jsonl` | Hash-chained audit log; `""` disables |
| `PHINQ_ENFORCE` | unset | `1`/`true` turns HOLD enforcement on (requires Telegram config) |
| `PHINQ_HOLD_TIMEOUT_S` | `240` | Approval window; >240 warns (Hermes stale detector) |
| `PHINQ_TELEGRAM_BOT_TOKEN` | unset | Bot token from @BotFather (secret — env only, never logged) |
| `PHINQ_TELEGRAM_CHAT_ID` | unset | Operator chat id; only this chat's buttons are honored |
| `PHINQ_LOG_LEVEL` | `info` | Pino log level |

## Classifier (shadow mode)

Every tool call gets an action class from the phinq-governance model —
`RISK_REDUCING` / `REVERSIBLE` / `IRREVERSIBLE_LOW` / `IRREVERSIBLE_MEDIUM` /
`IRREVERSIBLE_HIGH` — via deterministic name-pattern rules plus argument
inspection (recursive `rm`, `sudo`/`chmod`, pipe-to-shell, `.env`/secret
paths, recipient counts, bulk item counts). `MEDIUM`, `HIGH`, and any
structural trigger decide HOLD; everything else ALLOWs. Unrecognized tool
names ALLOW but are flagged `unknown_tool` for calibration.

Structural triggers (categories fixed, thresholds tunable): `BULK_DELETE`
(>5), `CREDENTIAL_ACCESS`, `DISABLE_SAFEGUARDS`, `EXTERNAL_COMM_VOLUME`
(>3 sends/session), `PERMISSION_ESCALATION`, `BILLING_MODIFICATION`,
`AFTER_ERROR_BULK` (bulk op within 10 min of an error).

"Session" is the client API key (stored only as a SHA-256 hash) over a
rolling 60-minute window — an approximation, since the proxy has no true
agent-session identity.

### phinq.yaml

```yaml
thresholds:
  external_comm_volume: 3   # sends per session window before HOLD
  bulk_delete_count: 5      # deletes per window / items per call
session:
  window_minutes: 60
  error_window_minutes: 10
tools:                      # exact tool name → class override
  send_newsletter: REVERSIBLE
  custom_pay_tool: IRREVERSIBLE_HIGH
```

## Enforcement (holds + Telegram)

Setup once: create a bot with [@BotFather](https://t.me/BotFather), send it
one message (so it can message you back), get your chat id (e.g. via
@userinfobot), then:

```bash
PHINQ_ENFORCE=1 \
PHINQ_TELEGRAM_BOT_TOKEN=123456:ABC... \
PHINQ_TELEGRAM_CHAT_ID=123456789 \
npm start
```

On a HOLD the **entire response is held atomically** (one message, one
Approve/Deny for all calls in it):

- **Approve** → the original upstream response is released, byte-identical.
- **Deny / timeout (240s default → auto-deny)** → the agent receives a
  synthetic denial: a valid completion mirroring the held response's `id`,
  `model`, and `usage`, `finish_reason: "stop"`, **no** `tool_calls` key,
  with a message telling the agent not to retry and to continue. The agent
  loop proceeds gracefully; the held action never executes.
- **Agent disconnects first** → the hold becomes `EXPIRED_CLIENT`; the action
  is not executed; a late approval gets "arrived late — not executed."

Buttons are authenticated: callbacks must come from `operator_chat_id` and
carry an HMAC tag keyed on a per-install secret. First decision wins; later
clicks get "already approved/denied". The Telegram message is edited to show
the final state. If enforcement is requested but Telegram isn't configured,
the proxy warns and stays in shadow mode. Pending holds found at startup
(crash recovery) become `EXPIRED_CLIENT` — never silently executed.

`phinq.yaml` equivalents: `hold.enforce`, `hold.timeout_seconds`,
`telegram.operator_chat_id` (env vars win; the bot token is env-only).

## Audit log (tamper-evident)

Every classified tool call and every hold transition is appended to
`phinq-audit.jsonl`. Each entry carries `prev_hash` and
`entry_hash = sha256(prev_hash + jcs(entry))`, where `jcs` is RFC 8785
canonical JSON — so the chain verifies identically across Node versions.
The first line of each file is a genesis entry with a random `log_id`.
Restarts resume the existing chain.

```bash
npm run audit:verify -- phinq-audit.jsonl
# OK — 1402 entries, chain intact
# or: TAMPER DETECTED — first break at entry 217 (ts …); reason: entry modified
```

Modifying, reordering, or deleting any historical entry breaks the chain at
that index. Tool-call **arguments never enter the audit chain** (they stay in
the corpus file); the chain records intent — function name, action class,
triggers, decision, hold outcome. Known limitation: truncating the *tail* of
the file is not detectable from the file alone; anchoring the chain head
externally is post-MVP.

### Replay — calibrate before enforcing

```bash
npm run replay -- phinq-toolcalls.jsonl [phinq.yaml]
```

Re-classifies a captured corpus and reports decision counts, would-be HOLDs
with reasons, and unrecognized tool names. Component 3's definition of done:
a day of real traffic replays with **zero false HOLDs** on routine operations.
Tune `phinq.yaml`, re-run, repeat.

## Endpoints

- `POST /v1/chat/completions` (also `/api/v1/...`) — governed chat path
- `POST /v1/responses` (also `/api/v1/...`) — governed Responses path (Codex, OpenAI Agents SDK); classify + hold
- `POST /v1/messages` — governed Anthropic Messages path (Anthropic SDK); classify + hold; forwards to the Anthropic upstream
- `ALL /v1/*`, `/api/v1/*` — blind passthrough to OpenRouter
- `GET /healthz` — liveness

## Test

```bash
npm test
```

## What the proxy logs

To stdout: method, path, model, status, latency, and the **names** of tool
calls observed. **Never**: API keys (pino redaction), message contents, or
completion text.

To the corpus file (`PHINQ_TOOLCALL_LOG`, local disk only): one JSON line per
observed tool call — function name, the raw arguments JSON the model produced,
response/model IDs, and whether the arguments parsed cleanly. Arguments can
contain whatever the model put in them (email bodies, file paths), so treat
the corpus file as sensitive. Inspection is read-only and fail-open: a corpus
write failure never delays or alters the relayed response.
