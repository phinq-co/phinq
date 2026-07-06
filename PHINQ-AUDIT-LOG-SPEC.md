# Phinq Audit Log — Format Specification

**Version 1** · matches `@phinq/phinq` ≥ 1.0.0 (reference implementation: [`proxy/src/audit.ts`](proxy/src/audit.ts))

This document specifies the hash-chained JSONL audit log written by the Phinq
proxy and MCP gateway. It is complete enough to implement an independent
writer or verifier without reading the reference code.

## 1. Design goals

1. **Tamper-evident** — modifying, reordering, or deleting any historical
   entry is detectable by re-computing the chain.
2. **Append-only JSONL** — one JSON object per line; `grep`/`jq`-friendly; no
   database required to read it.
3. **No payloads** — the chain records *intent and classification*
   (tool name, risk class, decision, byte counts), never tool-call arguments
   or message content. Arguments live only in the separate local corpus file
   (`phinq-toolcalls.jsonl`), which is **not** part of the chain.
4. **Deterministic bytes** — hashing uses RFC 8785 canonical JSON (JCS), so
   independent implementations in any language produce identical hashes.

## 2. File format

- UTF-8 text file, one JSON object per line (`\n` separated). Blank lines are
  ignored by verifiers.
- Line 1 MUST be a `genesis` entry.
- Every line carries two chain fields **in addition to** its entry fields:

| Field | Type | Meaning |
|---|---|---|
| `prev_hash` | string, 64 lowercase hex chars | `entry_hash` of the previous line. For the genesis entry: 64 zeros (`"000…0"`). |
| `entry_hash` | string, 64 lowercase hex chars | `SHA-256(prev_hash ‖ JCS(entry))`, hex-encoded — see §3. |

`entry` means the JSON object **minus** `prev_hash` and `entry_hash`.

## 3. The chain

### 3.1 Hash computation

```
entry_hash = SHA256_hex( prev_hash + jcs(entry) )
```

- `prev_hash` is the 64-char hex string itself (ASCII bytes, not decoded).
- `jcs(entry)` is the RFC 8785 canonicalization of the entry object with the
  two chain fields removed. Object keys that hold `undefined` (in JS terms:
  absent) are omitted entirely.
- Concatenation is plain string concatenation; the digest is over the UTF-8
  bytes of the resulting string.

### 3.2 JCS in brief (what an implementer must get right)

RFC 8785 canonical JSON:

- Object keys sorted by **UTF-16 code units** (this is JavaScript's default
  `Array.prototype.sort()` on strings — beware locale-aware sorts).
- No whitespace anywhere.
- Numbers serialized with the ES6 `Number::toString` algorithm (shortest
  round-trip form; `1.0` → `"1"`, `1e21` → `"1e+21"`). Non-finite numbers are
  illegal.
- Strings serialized as JSON strings (standard escapes).
- `undefined` array elements become `null`; `undefined` object members are
  dropped.

A ~20-line implementation is in [`proxy/src/audit.ts`](proxy/src/audit.ts)
(`jcs()`), and a Python equivalent can use `json.dumps(entry, sort_keys=True,
separators=(",", ":"), ensure_ascii=False)` — which matches JCS for the field
shapes Phinq writes (ASCII field names, no exotic numbers), though a strict
implementation should use a real JCS library.

### 3.3 What the chain proves — and what it doesn't

| Attack | Detected? | How |
|---|---|---|
| Edit any field of a historical entry | ✅ | its `entry_hash` no longer matches its content |
| Reorder entries | ✅ | `prev_hash` links break |
| Delete an entry in the middle | ✅ | the successor's `prev_hash` points at a hash that no longer precedes it |
| Insert a fabricated entry | ✅ | breaks the successor's `prev_hash` (an attacker would have to re-write every subsequent hash — possible only with write access to the whole file, see next row) |
| **Re-write the entire file from scratch** | ❌ from the file alone | requires an externally anchored head hash (see §6) |
| **Truncate the tail** | ❌ from the file alone | same — anchor the latest `entry_hash` externally |

The honest summary: the chain makes *silent, partial* tampering detectable.
An attacker with full write access can rebuild the whole file; defending
against that requires periodically recording the latest `entry_hash`
somewhere the attacker can't reach (a different machine, a ticket, a tweet —
anything external). This is deliberate MVP scope (§6).

## 4. Entry types

All entries share `type` (string) and, except genesis, `ts` (ISO-8601 UTC
timestamp with milliseconds, e.g. `"2026-07-03T22:24:46.951Z"`).
Verifiers MUST accept unknown extra fields (the format is forward-extensible)
and MUST include them in the hash (they hash whatever is on the line).

### 4.1 `genesis` — first line of every log

| Field | Type | Notes |
|---|---|---|
| `type` | `"genesis"` | |
| `log_id` | string (UUID v4) | identifies this chain instance |
| `created_at` | ISO-8601 string | |

### 4.2 `decision` — one per classified tool call (shadow and enforce alike)

| Field | Type | Notes |
|---|---|---|
| `type` | `"decision"` | |
| `ts` | string | |
| `response_id` | string? | upstream response id, when the dialect provides one |
| `model` | string? | response model, falling back to request model |
| `function_name` | string? | the tool being called |
| `action_class` | string? | `RISK_REDUCING` \| `REVERSIBLE` \| `IRREVERSIBLE_LOW` \| `IRREVERSIBLE_MEDIUM` \| `IRREVERSIBLE_HIGH` |
| `triggers` | string[]? | structural triggers that fired (e.g. `DISABLE_SAFEGUARDS`) |
| `decision` | `"ALLOW"` \| `"HOLD"` | classifier verdict |
| `enforced` | boolean | `true` = enforce mode (HOLD actually blocked), `false` = shadow (logged only) |
| `hold_id` | string? | present when `decision:"HOLD"` and a hold was created |
| `args_bytes` | number? | size of the arguments — the payload itself is never here |

### 4.3 `hold_transition` — every hold state change, including creation

| Field | Type | Notes |
|---|---|---|
| `type` | `"hold_transition"` | |
| `ts` | string | |
| `hold_id` | string | 8-char base64url id |
| `status` | string | `PENDING` (creation), then one of `APPROVED`, `DENIED`, `EXPIRED_TIMEOUT`, `EXPIRED_CLIENT` |
| `decided_by` | string? | who decided, namespaced: `telegram:<user_id>`, `slack:<user_id>`, `local:cli`; absent for `PENDING`/expiry |

### 4.4 `usage` — per-response token accounting (the TOKEN_BUDGET fuel gauge)

| Field | Type | Notes |
|---|---|---|
| `type` | `"usage"` | |
| `ts` | string | |
| `model` | string? | |
| `session` | string? | first 12 hex chars of the session-key hash — correlation, not identity; never the raw key |
| `tokens_prompt` | number | |
| `tokens_completion` | number | |
| `tokens_total` | number | |

### 4.5 `policy_change` — a `phinq learn --apply` run

Policy evolution is chain-recorded so a reader can replay *which rules were in
force when*.

| Field | Type | Notes |
|---|---|---|
| `type` | `"policy_change"` | |
| `ts` | string | |
| `source` | string | e.g. `"phinq learn"` |
| `changes` | array | each: `{tool, to, action, basis, approvals, denials, holds}` — the cited evidence for the change |

## 5. Example log (3 entries, hashes abbreviated for print — real ones are 64 chars)

```jsonl
{"type":"genesis","log_id":"5f1c…","created_at":"2026-07-03T01:00:00.000Z","prev_hash":"000…000","entry_hash":"a3f1…"}
{"type":"decision","ts":"2026-07-03T01:43:29.180Z","model":"deepseek/deepseek-v4-flash","function_name":"delete_production_database","action_class":"IRREVERSIBLE_MEDIUM","triggers":[],"decision":"HOLD","enforced":true,"hold_id":"1tI8qPKK","args_bytes":24,"prev_hash":"a3f1…","entry_hash":"9c02…"}
{"type":"hold_transition","ts":"2026-07-03T01:44:21.384Z","hold_id":"1tI8qPKK","status":"DENIED","decided_by":"telegram:1365985527","prev_hash":"9c02…","entry_hash":"4be7…"}
```

## 6. Verification algorithm

A conforming verifier (reference: `verifyChain()` in
[`proxy/src/audit.ts`](proxy/src/audit.ts); CLI: `phinq audit verify <file>`):

```
prev = "0" * 64
for each non-blank line, in file order:
    parsed = JSON.parse(line)            # unparseable → FAIL "unparseable line"
    entry  = parsed minus {prev_hash, entry_hash}
    if first line and entry.type != "genesis":   FAIL "missing genesis entry"
    if parsed.prev_hash != prev:                 FAIL "modified, reordered, or removed"
    if parsed.entry_hash != sha256_hex(prev + jcs(entry)):
                                                 FAIL "entry modified"
    prev = parsed.entry_hash
PASS with the entry count; report `prev` as the chain head
```

On failure, report the index and timestamp of the first broken link — every
entry *before* it is still verified.

**External anchoring (recommended, out of band):** periodically record the
current chain head (the last `entry_hash`) somewhere outside the machine that
writes the log. Any later verification whose head doesn't extend from an
anchored value reveals whole-file rewrite or truncation — the two attacks §3.3
shows the file alone cannot catch.

## 7. Edge cases (normative)

| Case | Behavior |
|---|---|
| **Empty file / no lines** | Verifies OK with `entries: 0`. (A writer never produces this — it writes genesis on creation — but a verifier must not crash.) |
| **Blank lines** | Skipped; not hashed; do not break the chain. |
| **Missing genesis** | First non-blank line with `type != "genesis"` → fail at index 0. |
| **Unparseable line** | Fail at that index with `"unparseable line"`. Entries before it remain verified. |
| **Writer restart** | The writer resumes the chain by reading the last line's `entry_hash`. If the tail line is unparseable (e.g. crash mid-write), the writer logs a warning and its new appends will NOT chain — the verifier will then fail at the seam. This is intentional: a torn tail must be human-inspected, not silently papered over. |
| **Multiple logs** | Each file is an independent chain with its own `log_id`. Chains are never merged; `phinq report` may read several. |
| **Unknown `type`** | Hash-verify normally; ignore semantically. |
| **Duplicate timestamps / out-of-order `ts`** | Legal. Ordering is defined by chain position, not timestamps. |

## 8. What is deliberately NOT in the chain

- Tool-call **arguments** and message **content** — corpus file only
  (`phinq-toolcalls.jsonl`, plain JSONL, not hash-chained, may be rotated or
  deleted by the operator).
- Raw **session keys** or API keys — only a 12-hex-char hash prefix, ever.
- Classifier **reasons** (the plain-English strings) — they are derivable by
  re-running the deterministic classifier over the corpus; the chain stores
  the decision, class, and triggers.
