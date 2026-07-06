# Changelog

All notable changes to the Phinq proxy (`@phinq/phinq`) and SDKs. Versions
refer to the proxy package unless noted; `@phinq/governance` (TS SDK) and
`phinq` (PyPI) are versioned separately.

## 1.2.2 — 2026-07-06

**DISABLE_SAFEGUARDS read/write split + legible holds.** Dogfooding surfaced
the failure mode: on a machine where the agent works *on* the phinq repo,
every **read** of a governance file (skill_view, read_file, `cat`, `wc`,
`npm run replay`) tripped DISABLE_SAFEGUARDS, burying the operator in
identical opaque holds.

- DISABLE_SAFEGUARDS now fires only on a **mutation** of the governance
  layer: write/edit/delete tools, and destructive shell commands
  (`rm`/`mv`/`sed -i`/`>` redirects — fd redirects like `2>/dev/null`
  excluded) touching governance paths. Pure reads pass. Still structural —
  not relaxable via phinq.yaml.
- Telegram and CLI hold prompts (and `/phinq/holds`) now show a plain-English
  `why:` line from the classifier's reasons, not just the trigger code.
- Replay over a live 401-call corpus: 27 → 11 holds; all 11 remaining are
  genuine mutations. Python classifier mirrored byte-for-byte.

## 1.2.1 — 2026-07-05

- **Opt-in gate auth**: `PHINQ_GATE_TOKEN` guards `POST /phinq/gate` and
  `/phinq/classify` (timing-safe Bearer compare). Unset = open, matching the
  localhost trust model; set it when binding `PHINQ_HOST=0.0.0.0`.
- **Internal**: the three non-streaming dialect handlers (Responses,
  Messages, Gemini) collapsed into one `governDialect` core with per-dialect
  descriptors (−227 lines). Behavior-identical; chat and the gate stay
  separate by design.

## 1.2.0 — 2026-07-04

**Gemini dialect (4th) + universal HTTP gate**, then hardened by a
13-finding multi-agent review before npm publish.

- **Gemini `generateContent` governance** (`/v1beta/*`, `/v1alpha/*`, and
  `:generateContent` on `/v1`): functionCall extraction, all three wire forms
  (JSON, chunked-array stream, SSE `?alt=sse`), Gemini-shaped denials, model
  parsed from the URL. Google's OpenAI-compat endpoint
  (`/v1beta/openai/chat/completions`) is governed through the chat dialect —
  not a bypass. `?key=` values scrubbed from all logs; `x-goog-api-key`
  redacted; `usageMetadata` feeds the token fuel gauge.
- **Universal HTTP gate**: `POST /phinq/gate` — classify → hold → operator
  decision over plain HTTP for any language/framework with no wire dialect
  (n8n, Go, Java, custom loops). `POST /phinq/classify` = pure advisory
  lookup. Shadow mode never blocks (`"shadow": true`).
- **Streaming holds done right**: held streaming requests keep the socket
  alive (SSE headers + keep-alive comments during the approval window), then
  stream the reconstructed frames; denial/timeout can no longer surface as a
  zero-byte reply.
- **SSE fidelity**: usage chunk gated behind `stream_options.include_usage`;
  provider extras (reasoning, refusal, function_call) preserved;
  200-with-`{error}` bodies surfaced as an error frame; multi-line non-JSON
  bodies framed per-line.
- Wizard detects Gemini CLI (`~/.gemini`); Hermes snippet corrected to the
  named-provider form (the built-in openrouter provider ignores `base_url`).

## 1.1.0 — 2026-07-03 *(not published to npm; deployed to the dogfood VPS)*

- **Streaming support on the chat dialect**: `stream:true` requests are
  coerced to a non-streamed upstream fetch, governed atomically, and
  re-emitted as SSE.
- **Self-modification trigger**: DISABLE_SAFEGUARDS broadened beyond
  `phinq.yaml`/audit files to the whole governance layer — `phinq.env`,
  hold/session state, the `.phinq` directory, and the phinq-governance skill
  definition (caught live: an agent patching its own governance skill had
  classified IRREVERSIBLE_LOW/ALLOW).

## 1.0.1 – 1.0.3 — 2026-07-03

- **1.0.2 fix**: `phinq-mcp` was missing its shebang — the bin crashed for
  every npm install (`sh: /Applications: is a directory`). Found by
  dogfooding the published package.
- **1.0.3 docs**: recommend `npm i -g @phinq/phinq` + direct `phinq-mcp` in
  MCP configs — nested `npx`-inside-`npx` fails to resolve the wrapped
  command on some setups.
- Published under the interim scoped name **`@phinq/phinq`** (bare `phinq`
  name request pending with npm support). Wizard runs as `npx @phinq/phinq`.

## 1.0.0 — 2026-07-02

First complete release: everything below shipped as one system.

- **Proxy** (Fastify, Node 22+): OpenAI Chat Completions, OpenAI Responses,
  and Anthropic Messages dialects; transparent header passthrough; shadow vs
  enforce (`PHINQ_ENFORCE=1`).
- **Deterministic classifier**: five action classes, structural triggers
  (BULK_DELETE, CREDENTIAL_ACCESS, DISABLE_SAFEGUARDS, EXTERNAL_COMM_VOLUME,
  PERMISSION_ESCALATION, BILLING_MODIFICATION, AFTER_ERROR_BULK,
  TOKEN_BUDGET), session velocity windows, `phinq.yaml` thresholds + tool
  overrides. No LLM judge.
- **Holds**: Telegram, Slack (Socket Mode), and local CLI approval
  (first decision wins); auto-deny on timeout; client-disconnect kills the
  hold.
- **Hash-chained audit log** (RFC 8785 JCS + SHA-256) with `phinq audit
  verify`; tool-call corpus + `replay` calibration; **`phinq report`**
  human-oversight evidence (false-hold rate, damage prevented, token spend).
- **Token regulation**: per-session usage accounting, opt-in
  `session_token_budget` checkpoint.
- **Precedent**: `phinq learn` compiles approve/deny history into cited
  policy proposals; `--apply` writes phinq.yaml and chain-records the change.
- **MCP gateway** (`phinq-mcp`): wrap any stdio MCP server.
- **SDKs**: `@phinq/governance` (TypeScript, in-process gate + Mastra
  adapter), `phinq` on PyPI (Python ≥3.10 classifier + governor + LiteLLM
  guardrail), test suites mirrored so the engines provably agree.
- **`npx` setup wizard**: detects Claude Code / Codex / Hermes / Cursor,
  writes `~/.phinq/`, prints the one line to paste.
