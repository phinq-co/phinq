# Day-0 Findings — Hermes client behavior

Date: 2026-06-10. Source: direct reading of the installed Hermes agent
(`~/.hermes/hermes-agent/`, file:line refs below) plus a working measurement
stub (`day0/stub.mjs`, self-tested). Live config inspected: `~/.hermes/config.yaml`.

## 1. `stream:false` — SUPPORTED ✅ (with one wrinkle)

Hermes has a complete non-streaming code path (`run_agent.py:6328`), but in
interactive sessions it **defaults to streaming** (`run_agent.py:10916`).

The wrinkle resolves itself: when a streaming attempt fails with an error whose
message contains `"stream"` **and** `"not supported"` (case-insensitive),
Hermes sets `_disable_streaming = True` — a sticky, session-long switch to
non-streaming with full retry handling (`run_agent.py:7207-7216`).

**Proxy decision:** MVP requires `stream:false` as planned. On `stream:true`
requests, return HTTP 400 with:

```json
{"error": {"message": "Streaming is not supported by this endpoint; retry with stream:false.",
           "type": "invalid_request_error", "code": "stream_not_supported"}}
```

This exact shape is implemented in the stub and verified to satisfy the
fallback predicate. Cost: one failed round-trip at session start, then clean
non-streaming for the rest of the session. No SSE buffering needed for MVP.

## 2. Client timeout — the binding constraint is 300s, not 1800s ⚠️

Three layers (only the last one matters):

| Layer | Default | Where |
|---|---|---|
| httpx request timeout | 1800s (`HERMES_API_TIMEOUT`) | `run_agent.py:2773` |
| per-provider config timeout | unset (`providers: {}` in live config) | `hermes_cli/timeouts.py:14` |
| **non-stream stale detector** | **300s** — actively kills the connection | `run_agent.py:2798, 6342-6394` |

The stale detector polls elapsed time and closes the socket at the threshold.
It scales with context: 450s above ~50k tokens, 600s above ~100k
(`run_agent.py:2799-2812`). Overridable via
`providers.openrouter.stale_timeout_seconds` in `config.yaml` or
`HERMES_API_CALL_STALE_TIMEOUT` env (`hermes_cli/timeouts.py:43-69`).

**Spec change (applied to PROXY-MVP.md):** the v0.2 hold default of 540s is
dead on arrival against stock Hermes — the agent hangs up at 300s and every
hold becomes `EXPIRED_CLIENT`. New contract:

- Proxy default `hold_timeout_seconds: 240` (300s − 60s margin).
- README recipe for longer windows: in Hermes `config.yaml` set
  `providers: { openrouter: { stale_timeout_seconds: 660 } }` → then
  `hold_timeout_seconds: 600` is safe. The proxy cannot detect the agent-side
  setting, so config validation stays a warning, not an error.

## 3. Streaming timeouts (recorded for post-MVP SSE work)

- `HERMES_STREAM_READ_TIMEOUT` — 120s between bytes (`run_agent.py:6686`)
- `HERMES_STREAM_STALE_TIMEOUT` — 180s without deltas (`run_agent.py:7243`)
- `HERMES_STREAM_RETRIES` — 2 (`run_agent.py:6983`)

SSE comment heartbeats could defeat the 120s read timeout, but the 180s
delta-stale detector would still trip. Streaming holds stay out of scope.

## 4. Endpoint usage

Live config (`~/.hermes/config.yaml:1-5`): provider `openrouter`, base URL
`https://openrouter.ai/api/v1`, `api_mode: chat_completions`, model
`nvidia/nemotron-3-super-120b-a12b:free`. Adopting the proxy is exactly the
one-line change the pitch claims: `base_url: http://127.0.0.1:<port>/api/v1`.

Full list of `/v1/*` paths Hermes touches: collect with the stub in `log`
mode during the day-1 corpus run (it records every method+path).

## 5. Empirical confirmation run (manual, ~6 minutes)

Code-derived numbers above are high-confidence; to confirm on the wire:

```bash
node proxy/day0/stub.mjs --mode stall --port 5101
# in ~/.hermes/config.yaml set model.base_url: http://127.0.0.1:5101/api/v1
# start hermes, send any prompt, wait
# expect in day0-observations.jsonl:
#   stream_rejected            (Hermes tried streaming first)
#   stall_begin                (retried with stream:false)
#   client_gave_up elapsed≈300 (stale detector killed the connection)
# restore base_url afterwards
```

Not run automatically — it requires editing the live agent's config.

## Consequences for the build

1. Day-1 passthrough is unblocked: require `stream:false`, return the tested
   400 on streaming requests.
2. Component 4 hold contract updated: default 240s; 10-minute holds need the
   documented Hermes-side knob.
3. `EXPIRED_CLIENT` rate in dogfooding directly measures whether operators
   applied the knob — if it's nonzero, the README recipe isn't landing.
