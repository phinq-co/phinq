# Test Gap Analysis

Snapshot at v1.2.2 (proxy: 144 tests / 15 files, python: 40, sdk: 10). This
is a working document for contributors: each gap names the untested behavior,
where the code lives, and the specific test to add.

## Priority 1 — would break silently, high blast radius

### 1. ~~TS ↔ Python classifier parity is enforced by discipline, not CI~~ ✅ CLOSED

Closed by the differential harness: `proxy/test/fixtures/parity-corpus.jsonl`
(34 cases covering every classifier branch) + `parity-expected.json`
(generated from the TS engine via `npm run parity:regen`), asserted by BOTH
`proxy/test/parity.test.ts` and `python/tests/test_parity.py`, with a
`test-python` CI job so drift fails the build. Workflow for an intentional
classifier change: change TS → `npm run parity:regen` → mirror into Python →
both suites green → the expected-file diff in the PR *is* the review surface.
Never hand-edit the expected file to make Python pass.

### 2. `telegram.ts` has no dedicated test file

`TelegramNotifier` is constructed in `test/holds.test.ts` and its
callback-HMAC/first-decision behavior is exercised indirectly via
`test/slack.test.ts` composite tests, but nothing pins:

- the hold **message format** — including the new `why:` reasons line added
  in v1.2.2 (`proxy/src/telegram.ts:69-98`). A formatting regression ships
  straight to the operator's phone.
- `editMessageText` terminal-state editing for Telegram specifically.
- behavior when the Telegram API errors/times out (notifier must fail-open;
  the hold must still be decidable via CLI).

**Add:** `test/telegram.test.ts` with a mock `sendMessage` capturing the text
— assert function name, class, trigger, `why:` line, and args truncation at
200 chars; assert a 500 from the API doesn't reject the hold flow.

### 3. Replay CLI has no test (`proxy/src/replay.ts`)

Replay is the calibration workflow the README tells every user to run before
enforcing — and it has zero coverage. A break here corrupts users'
tuning decisions without erroring.

**Add:** `test/replay.test.ts`: feed a 6-line corpus fixture (one ALLOW, one
HOLD-by-class, one HOLD-by-trigger, one unknown tool, one unparseable line,
one with session-velocity interplay) and assert the decision counts and that
an alternate `phinq.yaml` changes the result.

## Priority 2 — enforcement-path edges

### 4. Hold expiry through the *HTTP layer* (not just the store)

`test/holds.test.ts:59-77` covers `EXPIRED_TIMEOUT`/`EXPIRED_CLIENT` at the
store level, and the chat streaming path has a heartbeat test. Untested:

- a **non-streaming** dialect request whose hold times out end-to-end —
  assert the client gets the synthetic denial with `reason: timeout`
  (`governDialect` denial branch, `proxy/src/server.ts`).
- `POST /phinq/gate` whose hold **expires** — assert
  `{allowed:false, resolution:"EXPIRED_TIMEOUT"}` (currently only
  approve/deny are tested in `test/gemini.test.ts:349+`).
- client disconnect mid-hold on `governDialect` → `clientClosed` fires
  (`req.raw.once("close", …)`) and the action does not execute.

### 5. Proxy restart with PENDING holds

If the proxy restarts while a hold is PENDING, the in-memory waiter is gone.
What does the client experience, and what lands in the audit chain? There is
no test pinning this (see `HoldStore` construction in
`proxy/src/holds.ts`). Likely the most surprising real-world failure mode
for a new operator.

**Add:** store-level test: create hold → new `HoldStore` instance on the same
DB file → assert the stale PENDING hold is expired/decidable, not zombie.

### 6. Session velocity through the gate

`/phinq/gate` records send/delete events, but no test asserts the windows
accumulate: the 4th `send_email` through the gate with the same `session_key`
must trip EXTERNAL_COMM_VOLUME. (`parseGateBody`/gate handler in
`proxy/src/server.ts`; velocity logic covered only via dialect paths in
`test/proxy.test.ts`.)

## Priority 3 — dialect wire-shape edges

### 7. Gemini routes not fully pinned

`test/gemini.test.ts` covers `/v1beta` governed + blind passthrough and the
review added routing tests, but assert explicitly (cheap, one test each):

- `/v1alpha/models/x:generateContent` → governed (registered at
  `proxy/src/server.ts` `geminiDispatch`).
- `/v1beta/openai/chat/completions` → governed via the **chat** dialect and
  reaches the *Gemini* upstream (the ultrareview bypass fix — currently
  untested against regression).
- `:streamGenerateContent` end-to-end with a JSON-array body over the wire
  (unit parse is covered; the HTTP round-trip is not).

### 8. Upstream failure surfaces

`forwardOrFail` maps timeouts/refusals to OpenAI-style errors
(`proxy/src/server.ts`). Add: upstream socket refused → 502-shape body;
upstream exceeding `upstreamTimeoutMs` → timeout error; and for the chat
streaming path, the error must arrive as an SSE error frame, not JSON.

### 9. Non-200 upstream responses feed AFTER_ERROR_BULK

Every dialect records `sessions.record(key,"error")` on non-200. No test
asserts a 429 followed by a bulk op actually trips AFTER_ERROR_BULK through
the HTTP layer.

## Priority 4 — operator-facing utilities

- **Wizard interactive flow** (`proxy/src/init.ts` `runInit`): only the pure
  helpers are tested (`test/init.test.ts`). A scripted-stdin test (answers
  "1\n2\n…\n") asserting the files written to a temp HOME would catch
  prompt-order regressions.
- **`phinq.env` loading** (`loadEnvFile`): precedence rule "existing env
  wins" is untested.
- **Log redaction**: `scrubUrl` is unit-tested, but nothing asserts the
  pino request log line actually carries the scrubbed URL / redacted
  headers (capture the logger stream in a test).
- **Audit torn-tail resume**: `test/audit.test.ts` covers resume; add the
  unparseable-tail case — writer warns and the verifier fails at the seam
  (spec §7 behavior).

## What would break first if someone contributed a breaking change?

Ranked by (likelihood of silent breakage × user impact):

1. **Python/TS classifier drift** — no automated parity (gap #1).
2. **Telegram message rendering** — zero assertions (gap #2).
3. **Replay output** — zero assertions (gap #3), and users act on it.
4. **Restart-with-pending-holds semantics** — undefined behavior (gap #5).
5. The four *denial wire shapes* are well-pinned (anthropic/responses/
   gemini/sse test files) — a contributor breaking those gets caught. That
   is the strongest wall in the suite; the gaps above are the unguarded
   flanks.
