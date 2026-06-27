# Phinq Proxy — MVP Scope (v0.2)

## One-line definition

An OpenRouter-compatible proxy that sits between an agent and its LLM provider, deterministically inspects every model response for tool calls before the agent runtime receives them, and holds high-risk calls pending operator confirmation via Telegram.

The operator changes one line of config (base URL) and every action their agent takes is governed — regardless of which tools the runtime has, including tools that don't exist yet.

## Spec decisions new in v0.2

1. **Day-0 checklist added** — measure Hermes's HTTP client timeout and confirm `stream:false` support *before* writing code; both reshape the build if wrong.
2. **Hold timeout is bounded by the client timeout** — approval window must end before the agent's HTTP client gives up, with explicit `EXPIRED_CLIENT` semantics for late approvals.
3. **Mixed-response policy** — if any tool call in a response classifies HOLD, the entire response is held atomically. One Telegram message, one Approve/Deny for the whole response.
4. **Synthetic denial shape pinned** — plain assistant message, `finish_reason: "stop"`, **no** `tool_calls` key. Because the agent never saw the held call, there is no dangling `tool_call_id` to satisfy. Never leak a held call and deny it afterward.
5. **Canonical JSON pinned to RFC 8785 (JCS)** for the audit hash chain — otherwise serializer drift across Node versions produces false tamper reports.
6. **Telegram approvals are authenticated** — operator chat-ID allowlist + per-hold HMAC nonce in callback data; first decision wins, later clicks are no-ops.
7. **"Session" defined for velocity triggers** — per client API key over a rolling window (default 60 min), persisted in SQLite. It's an approximation; documented as such.
8. **Passthrough scope defined** — only `POST /v1/chat/completions` is governed; every other `/v1/*` path (e.g. `GET /v1/models`) is blind-proxied. Upstream errors pass through unchanged.

## What the MVP must do

1. Accept OpenAI-format chat completion requests (what OpenRouter speaks, so what Hermes sends)
2. Forward them to OpenRouter unchanged, using the operator's own API key passed through
3. Parse the response before returning it to the agent
4. No tool calls → pass through untouched, minimal logging
5. Tool calls present → classify each one with the deterministic engine
6. All ALLOW → pass through, append audit entry per call
7. Any HOLD → hold the **entire response** (atomic); send Telegram confirmation; on approve, release the original response; on deny or timeout, return the synthetic denial so the agent loop continues gracefully
8. Append every decision to a hash-chained audit log

That's the whole MVP. Everything else is later.

## Architecture

```
Hermes ──HTTP──▶ Phinq Proxy ──HTTP──▶ OpenRouter ──▶ model
                    │
                    ├─ Classifier (deterministic, ported from Phinq TS engine)
                    ├─ Hold queue (in-memory + SQLite persistence)
                    ├─ Telegram notifier (operator confirmation)
                    └─ Audit log (hash-chained JSONL)
```

Single Node/TypeScript service. Reuse the existing engine in `src/` — `ActionClass`, `InterventionStack` thresholds, `DecisionEngine` — as the classifier core.

**Latency budget:** classifier is pure-deterministic, in-process, no network calls. Target <50ms added p99 on the ALLOW path.

## Day 0 — before any code ✅ DONE (see proxy/DAY0-FINDINGS.md)

- [x] **Hermes client timeout:** the binding constraint is the non-stream **stale detector — 300s default** (not the 1800s httpx timeout). Scales to 450/600s on huge contexts. Overridable via `providers.openrouter.stale_timeout_seconds`. → hold default lowered to 240s below.
- [x] **`stream:false` supported.** Hermes defaults to streaming but falls back sticky-per-session when an error contains "stream" + "not supported" (`run_agent.py:7207`). The proxy returns exactly that 400 on `stream:true` (shape tested in `proxy/day0/stub.mjs`). No SSE buffering needed.
- [x] **Path logging tool built** (`proxy/day0/stub.mjs --mode log`) — full `/v1/*` path list lands with the day-1 corpus run. Known already: `POST /chat/completions` under base `.../api/v1`, `chat_completions` mode.

## Components in build order

### 1. Passthrough proxy (day 1–2) ✅ DONE (proxy/)

Fastify server. `POST /v1/chat/completions` is the governed path; all other `/v1/*` paths blind-proxy to `https://openrouter.ai/api/v1/*` with the client's auth header. Upstream non-200s and headers pass through unchanged (minus hop-by-hop). MVP requires `stream:false` (per day-0 confirmation). Health endpoint. Dockerfile.

**Done when:** Hermes pointed at the proxy works identically to pointing at OpenRouter directly.

*Built 2026-06-10:* `proxy/src/` (config / upstream / server / index), 8 integration tests passing (byte-identical forwarding, auth passthrough, non-200 + header passthrough, stream rejection matching the Hermes predicate, 502/504 error shapes), Dockerfile, README with the Hermes adoption + stale-timeout recipe. **Live-verified end-to-end:** real completion through the proxy to OpenRouter returned correctly; `/v1/models` passthrough 200; API key confirmed redacted from logs. Remaining for full DoD: run actual Hermes through it (one-line base_url change) — same procedure as DAY0-FINDINGS §5.

### 2. Tool call inspection (day 3–4) ✅ BUILT (proxy/src/toolcalls.ts)

Parse `choices[].message.tool_calls`. Extract function name + arguments JSON. No classification yet — log every observed tool call.

**Done when:** a day of Pose Creative traffic produces the complete list of tool calls Hermes actually makes. This corpus is the real-world trigger calibration data.

*Built 2026-06-10:* `extractToolCalls()` records one JSONL line per call (function name, raw arguments string, response/model IDs, finish_reason, args-parse flag) to `PHINQ_TOOLCALL_LOG` (default `phinq-toolcalls.jsonl`, `""` disables). Writes are serialized + fail-open — inspection can never alter or delay the relayed bytes (tested). Tool-call **names** also go to stdout; arguments only to the local corpus file (may contain message content — treated as sensitive, documented in README). 11 tests passing. **Live-verified:** real `get_weather` tool call from `openai/gpt-oss-120b:free` through the proxy landed in the corpus with parsed args; API key confirmed absent from logs and corpus. Remaining for full DoD: point Hermes at the proxy and run a day of Pose Creative traffic.

### 3. Deterministic classifier (day 5–8) ✅ BUILT, shadow mode (proxy/src/classifier.ts)

Port classification from the existing engine. Map tool calls to `ActionClass`:

- Pattern rules on function name: `delete*`, `remove*`, `send*`, `payment`, `cron*`, `credential`, `env*`, etc.
- Argument inspection: recipient counts, file paths outside workspace, `rm -rf` / `sudo` / force flags in shell args, `.env` / secrets paths
- Structural triggers from the skill spec (`triggers.md`): `BULK_DELETE`, `EXTERNAL_COMM_VOLUME` (>3 sends/session), `AFTER_ERROR_BULK`, `CREDENTIAL_ACCESS`, `PERMISSION_ESCALATION`, `BILLING_MODIFICATION`, `DISABLE_SAFEGUARDS`
- **Session state:** `session_key = sha256(client API key)`, rolling window default 60 min, counts in SQLite. Velocity/volume triggers evaluate within the window. Documented as an approximation (no true agent-session identity at the proxy layer).

`phinq.yaml` lets the operator override tool→class mappings, thresholds, and the session window. Sane defaults; zero-config works.

Decision output: **ALLOW or HOLD.** (Deny-without-asking and the L0–L5 ladder are post-MVP.)

**Done when:** replaying the day-3 corpus produces zero false HOLDs on routine Pose Creative operations.

*Built 2026-06-10:* `classifier.ts` (pure, deterministic — name rules + argument inspection + session triggers), `session.ts` (node:sqlite rolling window, session_key = sha256(auth header), key never stored), `phinq-config.ts` (phinq.yaml loader), `replay.ts` (`npm run replay -- corpus.jsonl [phinq.yaml]` — the DoD checker). Runs in **shadow mode**: every tool call in the corpus gets `action_class` / `decision` / `triggers` / `reasons` / `unknown_tool` annotations and a `would_hold` stdout log, but nothing is enforced until component 4. Unknown tools ALLOW (flagged) to protect the zero-false-HOLD target. 30 tests passing. **Live-verified:** through the running proxy, `shell_exec {"cmd":"ls -a"}` → REVERSIBLE/ALLOW and `shell_exec {"cmd":"cat .env"}` → IRREVERSIBLE_HIGH/HOLD + CREDENTIAL_ACCESS; key absent from all logs/DB. Remaining for DoD: replay a real day of Pose Creative traffic to zero false HOLDs.

### 4. Hold queue + Telegram confirmation (day 9–11) ✅ BUILT (proxy/src/holds.ts, telegram.ts)

**Timeout contract:** `hold_timeout_seconds` default **240** (Hermes's stale detector kills non-streaming connections at 300s stock — see DAY0-FINDINGS §2). For 10-minute holds, the operator sets `providers.openrouter.stale_timeout_seconds: 660` in Hermes `config.yaml` and raises `hold_timeout_seconds` to 600. The proxy can't see the agent-side setting, so config validation warns (not errors) when `hold_timeout_seconds > 240`.

On HOLD: persist the pending response in SQLite; send one Telegram message via bot API listing **all** tool calls in the held response — intent (function + key args), per-call classification, triggers matched — with inline **Approve / Deny** buttons that apply atomically to the whole response.

**Telegram auth:** only callbacks from `telegram.operator_chat_id` are honored. `callback_data = {hold_id, decision, hmac}` where the HMAC is keyed on a per-install secret. First decision wins and is terminal; later clicks get an "already approved/denied" answer. Every decision is audited with chat ID and timestamp.

**On approve (in time):** release the original upstream response to the still-open HTTP request (long-poll).

**On deny or timeout:** return the synthetic denial — a valid chat completion mirroring `id`, `model`, and `usage` from the held upstream response:

```json
{
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "This action was held by Phinq governance and denied by the operator. Do not retry it in another form. Continue with the remaining task."
    },
    "finish_reason": "stop"
  }]
}
```

No `tool_calls` key. The agent never saw the held call, so no orphaned `tool_call_id` exists.

**Late approval (`EXPIRED_CLIENT`):** if the agent's HTTP connection closes before a decision, the hold transitions to `EXPIRED_CLIENT`, the action is NOT executed, the pending Telegram message is edited to say so, and an approval arriving afterward gets "arrived late — action was not executed." All transitions audited.

**Done when:** a real held action on Hermes, approved from a phone, executes; a denied one doesn't and Hermes continues; a deliberately-late approval lands in `EXPIRED_CLIENT` without executing.

*Built 2026-06-10:* v0.4.0. `holds.ts` (SQLite-persisted state machine PENDING→APPROVED/DENIED/EXPIRED_TIMEOUT/EXPIRED_CLIENT, first-decision-wins via guarded UPDATE, long-poll waiters, per-install HMAC secret, startup recovery of orphaned PENDING holds → EXPIRED_CLIENT) + `telegram.ts` (getUpdates long-poll — no public URL needed; one message per held response listing all calls + classes + triggers; Approve/Deny callbacks HMAC-tagged within Telegram's 64-byte limit; chat-id allowlist; message edited on every terminal state). Synthetic denial per spec #4 (mirrors id/model/usage, no tool_calls). Enforcement gated: `PHINQ_ENFORCE=1` + bot token + chat id, else warns and stays shadow. 41 tests passing (approve releases original bytes / deny + timeout → denial shape / tampered HMAC + wrong-chat rejected / restart recovery / EXPIRED_CLIENT late-approval). **Live-verified** with real OpenRouter traffic + mock Telegram: `cat .env` call held 8s → notification with buttons sent → expiry → synthetic denial delivered to the client, message edited to "Expired", hold row EXPIRED_TIMEOUT in SQLite, key absent from all logs. Remaining for full DoD: operator creates the real bot (BotFather) and approves a live Hermes hold from a phone.

### 5. Hash-chained audit log (day 12–13) ✅ BUILT (proxy/src/audit.ts)

JSONL using the existing audit schema from `audit-format.md` (keep the actuarial fields). Add `prev_hash` and `entry_hash = sha256(prev_hash + jcs(entry))` where `jcs` is RFC 8785 canonicalization — no ad-hoc stringify. Genesis entry per log file: `{type: "genesis", log_id, created_at}`.

CLI: `phinq audit verify` walks the chain, reports the first break (index + timestamp). Optional later: anchor the chain head to a public remote — not MVP.

**Done when:** tampering with any historical entry — including reordering — is detected by `verify`, and `verify` passes across a Node version upgrade.

*Built 2026-06-10:* v0.5.0. `audit.ts` — minimal RFC 8785 (JCS) canonicalizer (~30 lines, zero deps; validated against the RFC's own number + UTF-16-sorting test vectors), `entry_hash = sha256(prev_hash + jcs(entry))`, genesis per file, restart resumes the chain (no double genesis). Entries: one `decision` per classified call (function name, class, triggers, decision, enforced flag, hold_id, args_bytes — **arguments never enter the chain**, they stay in the corpus) + `hold_transition` for PENDING and every terminal state. `npm run audit:verify -- file` reports first break with index + ts; detects modification, reordering, deletion (tail truncation needs external anchoring — post-MVP, noted). Note: audit-format.md referenced by the skill spec was never shipped; schema defined here keeps its actuarial intent (class/triggers/decision/outcome). 53 tests passing. **Live-verified:** real traffic chain verified OK; rewriting a historical HOLD→ALLOW detected at the exact entry.

### 6. Dogfood + calibrate (day 14+, ongoing)

All Pose Creative traffic through the proxy. Track: **false-HOLD rate** (the killer metric), incidents caught, added latency on the ALLOW path (<50ms target), and `EXPIRED_CLIENT` count (if it's nonzero in practice, the timeout contract is mis-tuned).

## Explicitly out of scope for MVP

- Streaming responses (`stream:false` required; SSE buffering only if day-0 forces it)
- Multi-operator / multi-tenant anything
- Hosted version — MVP is self-hosted, `docker run`
- Dashboard / web UI — Telegram + CLI only
- API formats beyond the OpenAI-compatible shape OpenRouter uses
- The L1–L5 graduated ladder (ALLOW/HOLD only)
- The risk network / data opt-in
- Prompt-injection detection on inputs (output-side tool governance only)

## Known limitations (README + pitch, stated plainly)

- Governs actions initiated through the LLM. Cron jobs running pre-written scripts without a model call are invisible to the proxy. (The skill layer + runtime hooks remain complementary.)
- An operator with shell access can bypass the proxy; this governs the agent, not a malicious human.
- Latency on HOLD is human-speed by design.
- "Session" at the proxy is an API-key + time-window approximation, not true agent-session identity; velocity triggers inherit that imprecision.

## How this slots into the existing story

- Skill (free, open standard) = advisory layer + distribution + the audit schema
- Proxy (open source core; hosted version later = the business) = enforcement layer
- Site copy "stop it before it doesn't" becomes true the day the proxy works
- The day-3 tool-call corpus + dogfooding incidents = the YC traction/data slide

## First milestone worth announcing

"I ran my agency's agent through Phinq for two weeks. 1,400 tool calls, 9 held, 2 denied — here's what it caught." That post does more than any launch announcement.
