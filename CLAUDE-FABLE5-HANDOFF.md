# Phinq — Handoff / Tribal Knowledge

Everything about Phinq that isn't obvious from reading the code: *why* things
are the way they are, the edges that surprised us, and the traps. Read this
before making changes; it will save you a debugging day.

## The one-paragraph mental model

Phinq is a **transparent reverse proxy** that sits between an agent and its LLM
upstream. It forwards the request untouched, lets the upstream respond, then
**inspects the response for tool calls** — it governs the model's *proposed
actions*, not the prompt. Each tool call is scored by a **pure deterministic
classifier** (no LLM). If anything scores HOLD and enforcement is on, the whole
response is parked in a SQLite hold store and the operator is pinged
(Telegram/Slack/CLI); on approve the original bytes are released verbatim, on
deny/timeout a **synthetic denial** (a valid response with the tool call
stripped) goes back so the agent continues safely. Every decision is appended
to a hash-chained audit log. That's the entire system; everything else is
dialect adapters and ergonomics.

**The subtlety that isn't obvious:** Phinq governs at the **response** boundary,
after the model has decided but before the agent executes. It relies on the
agent loop being "model proposes tool_call → client executes it." If a client
executed tool calls *inside* a single streamed turn without round-tripping,
Phinq couldn't gate them. In practice every real agent framework round-trips,
which is why this works.

## Why the big design decisions

- **Deterministic classifier, no LLM judge.** Same call + same session state →
  same verdict, always. This is a *product* decision, not just an engineering
  one: the pitch is "ungameable, auditable, reproducible." An LLM judge would
  be none of those. Never add one. Structural triggers are deliberately *not*
  relaxable via config for the same reason.
- **Govern the response, not the request.** You can only classify an action
  once the model has actually proposed it with concrete arguments. Classifying
  the prompt would be guessing.
- **Buffer streaming, then re-emit.** A `stream:true` chat request is coerced
  to `stream:false` upstream, governed atomically, then re-streamed to the
  client as SSE (`sse.ts`). You cannot hold "half a tool call," so we need the
  whole response before deciding. This is why there's a hijacked-socket
  heartbeat during a hold (§ streaming gotcha below).
- **Arguments never enter the audit chain.** The chain records intent + class +
  triggers + `args_bytes`, never payloads. Payloads live in the separate
  corpus file (`phinq-toolcalls.jsonl`), which is not chained and the operator
  can delete/rotate. This split is load-bearing for the privacy story and for
  the hosted layer's "payloads stay local" default.
- **Four dialects, one core.** `governDialect()` handles Responses/Messages/
  Gemini (structurally identical); chat is separate because of streaming; the
  gate is separate because it has no upstream. Do not try to unify all five —
  we deliberately didn't (see the v1.2.1 commit); the differences are real.

## Classifier quirks (the ones that bit us)

- **Snake_case defeats `\b`.** Underscore is a word char, so `\brm\b` does NOT
  match `rm` in `phinq_rm_backup`. Short tokens use explicit
  `(^|[_\W])…([_\W]|$)` boundaries. If you add a name rule with `\b`, test it
  against snake_case names or it silently won't fire.
- **Unknown tools are IRREVERSIBLE_LOW → ALLOW, not HOLD.** A tool no rule
  recognizes is flagged for calibration but *passes*. This surprised us during
  dogfooding: adding the 11 Hermes tools to `phinq.yaml` changed the hold count
  by **zero**, because they were never held for being unknown — they were held
  for referencing governance paths. Don't expect "classify the tool" to fix a
  hold-volume problem; check *why* it's held first.
- **Structural triggers override the base class.** DISABLE_SAFEGUARDS forces
  IRREVERSIBLE_HIGH regardless of the tool's name class. So making a tool
  "REVERSIBLE" in phinq.yaml won't stop a trigger from holding it.
- **DISABLE_SAFEGUARDS read/write split (v1.2.2) is the subtlest logic in the
  file.** It fires only on *mutations* of governance paths. Reads pass. For
  shell commands the read/write call is made by a regex
  (`SHELL_MUTATES_SAFEGUARD`) whose `(?<![\d&])` lookbehind exists solely to
  stop `2>/dev/null` and `2>&1` (fd redirects) from looking like `> file`
  writes. If you touch that regex, the `wc … 2>/dev/null` fixture in the tests
  is the one that catches the mistake. Fixed-length lookbehind only — keep it
  portable to Python's `re` (Python rejects variable-length lookbehind).
- **The path regex matches prose.** `SAFEGUARD_PATHS` matches any string
  containing e.g. `phinq-governance`. A `memory` note whose *text* mentions
  "phinq" trips it. Known residual false positive; acceptable because it's a
  write and rare. If you ever want to fix it, you'd need to distinguish
  "path argument" from "free text," which is hard — we chose not to.

## Proxy gotchas

- **Node 22+ is mandatory, and it's a footgun.** The hold/session stores use
  `node:sqlite`, which only exists in Node ≥ 22. On the VPS the interactive
  shell defaulted to Node 18 and everything broke confusingly (`replay`,
  `npm start`). `.bashrc` now forces `nvm use 22`. If a user reports weird
  `ERR_UNKNOWN_BUILTIN_MODULE` or SQLite errors, it's their Node version.
- **`upstreamTimeoutMs` default (280s) is tuned below Hermes's 300s stale
  detector on purpose.** The proxy must fail *before* the agent client gives up
  on a silent connection, or you get a hung agent instead of a clean error.
  The hold timeout (240s default) is likewise below both. If you raise either,
  you risk the client hanging up mid-hold. There's a startup warning above
  240s for exactly this.
- **Bodies are captured as raw bytes and forwarded verbatim.** The content-type
  parser is replaced with a pass-through buffer parser
  (`addContentTypeParser("*")`). Never re-serialize a client body — a
  re-encoded JSON can differ byte-wise and break signature-sensitive upstreams.
  Parse a *copy* for inspection only.
- **Streaming holds hijack the socket.** During a hold on a streaming request,
  Fastify's buffered reply can't emit bytes, so `streamHeldOutcome` calls
  `reply.hijack()`, writes SSE headers + a `: keep-alive` comment every 15s, and
  only writes the real frames once the operator decides. Every write is guarded
  by an `alive()` check because the client may have hung up (EXPIRED_CLIENT) —
  writing to a dead socket must be a no-op, not a crash. This is the most
  fragile code in the proxy; the review (finding #2) found it originally
  returned zero bytes. Touch with tests.
- **Gemini puts the API key in the URL** (`?key=…`). URLs get logged. `scrubUrl`
  runs in a custom pino request serializer *and* on explicit log lines. If you
  add a log line that includes `req.url`, scrub it. This is a
  secret-leak-class bug if forgotten.
- **Session key is a hash of the auth credential**, and the credential differs
  per dialect: `authorization` (chat/responses), `x-api-key` (Anthropic),
  `x-goog-api-key`/Bearer/`?key=` (Gemini), `gate:<session_key>` (gate). Only a
  12-hex-char prefix ever appears anywhere. If session velocity windows seem
  wrong, check you keyed off the right header for the dialect.
- **Fastify can't route Gemini's colon verb.** `:generateContent` looks like a
  route param, so Gemini traffic is caught by a `/v1beta/*` (and `/v1alpha/*`,
  and a guarded `/v1/*`) wildcard that dispatches on a URL regex
  (`isGeminiGenerateContent`). If you add Gemini routes, they go through the
  dispatcher, not `app.post`.

## Environment / config traps

- **`PHINQ_TOOLCALL_LOG=""` disables the corpus** (not "use default"). Empty
  string is meaningful. Same pattern for `PHINQ_AUDIT_LOG`.
- **Env wins over `phinq.yaml`** for enforce/timeout/telegram. `loadEnvFile`
  (the wizard's `~/.phinq/phinq.env`) uses "existing env wins" precedence —
  a shell export overrides the file.
- **`PHINQ_GATE_TOKEN` unset = open gate.** Intentional (localhost trust). Only
  set it for `PHINQ_HOST=0.0.0.0`. Don't "helpfully" default it on — that
  breaks the documented no-auth curl in the README/wizard.
- **Hermes's built-in `openrouter` provider ignores `model.base_url`.** This
  cost hours on the VPS. To route Hermes through the proxy you must define a
  *named custom provider* (`providers.phinq` with `base_url` + `key_env`), not
  set `base_url` under the default openrouter provider. The README and wizard
  now say this; if a Hermes user's traffic isn't reaching the proxy, this is
  why.

## Packaging / release traps

- **Bins need a shebang.** `phinq-mcp` shipped once without
  `#!/usr/bin/env node` and crashed for *every* install
  (`sh: /Applications: is a directory` — the shell globbed the first line).
  Both `cli.ts` and `mcp-main.ts` must start with the shebang. This is why
  `npm pack --dry-run | head -1 dist/*.js` is part of pre-publish now.
- **Scoped package + `--access public`.** Published as `@phinq/phinq` (bare
  `phinq` blocked by npm's similarity filter; appeal pending). Scoped packages
  publish *private* by default — you must pass `--access public` or the publish
  silently creates a paid-private package. If the appeal clears, swap the name
  in package.json + 4 doc refs + republish.
- **`prepublishOnly` runs build + test** — a failing test blocks publish. Good.
  But it means you can't publish from a dirty/broken tree, which has bitten
  fast releases.

## Unresolved / needs-a-human

- **Bare `phinq` npm name** — appeal pending with npm support. Revert the
  scoped name when it clears.
- **Responses dialect enforcement** — the Responses path *does* now hold
  (governDialect), but the original comment called it "shadow-only"; verify a
  real Codex `wire_api=responses` client round-trips a denial cleanly. Not
  yet tested against a live Codex.
- **No live Gemini end-to-end test** — the wire parsing is unit-tested and the
  routing is verified against Google's 403, but no real `GOOGLE_API_KEY` run
  has happened. First Gemini user is the real test.
- **`memory`-note false positive** (see classifier quirks) — leave or fix?
  Needs a product call on how aggressive the prose match should be.
- **Hosted layer** — designed (`HOSTED-LAYER-ARCH.md`), not built. The
  signed-decision detail in §6 is the part most likely to be cut for a v1 and
  most important not to forget.

## Partially-done / watch for

- **TS/Python classifier parity is manual.** No automated differential test yet
  (see `TEST-GAPS.md` #1). Every classifier change must be hand-mirrored into
  `python/src/phinq/classifier.py` and both test suites updated. This is the
  most likely source of silent drift.
- **`telegram.ts` has no dedicated test** (`TEST-GAPS.md` #2). The v1.2.2
  `why:` line is unpinned — a formatting change ships straight to a phone.
- **Version drift between deploy targets is normal here.** The VPS and GitHub
  often run ahead of npm (npm publish needs a human Touch ID). When debugging a
  user issue, check `npm view @phinq/phinq version` vs the repo — they are
  frequently different on purpose. As of this writing GitHub/VPS = 1.2.2,
  npm = 1.2.1.
