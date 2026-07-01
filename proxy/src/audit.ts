import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

/**
 * Component 5 — hash-chained audit log (PROXY-MVP.md, day 12–13).
 *
 * JSONL where every entry carries:
 *   prev_hash  — entry_hash of the previous line (64 zeros for genesis)
 *   entry_hash — sha256(prev_hash + jcs(entry))   [hex]
 * where jcs() is RFC 8785 canonical JSON and `entry` excludes the two hash
 * fields themselves. Any edit to a historical entry — or any reordering —
 * changes a hash and breaks every subsequent link.
 *
 * JCS (not ad-hoc stringify) so the canonical bytes are identical across
 * Node versions and serializer quirks: object keys sorted by UTF-16 code
 * units, no whitespace, ES6 number-to-string (which JSON.stringify already
 * implements per spec).
 *
 * Tamper detection covers modification and reordering. Truncation of the
 * *tail* is not detectable from the file alone — that requires anchoring the
 * chain head externally (explicitly post-MVP in the spec).
 */

const GENESIS_PREV = "0".repeat(64);

/** RFC 8785 (JCS) canonicalization for JSON-safe values. */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS: non-finite numbers are not JSON");
    return JSON.stringify(value); // ES6 ToString — exactly what JCS requires
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => jcs(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort(); // default sort = UTF-16 code unit order, as JCS requires
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`
    );
    return `{${parts.join(",")}}`;
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}

export function entryHash(prevHash: string, entry: Record<string, unknown>): string {
  return createHash("sha256").update(prevHash + jcs(entry)).digest("hex");
}

// ---------------------------------------------------------------------------
// Entry shapes
// ---------------------------------------------------------------------------

/** Genesis — first line of every log file. */
export interface GenesisEntry {
  type: "genesis";
  log_id: string;
  created_at: string;
}

/**
 * One per classified tool call (shadow and enforce alike). Actuarial fields
 * per the phinq-governance skill; arguments stay in the corpus file, the
 * audit chain records intent + classification, not payloads.
 */
export interface DecisionEntry {
  type: "decision";
  ts: string;
  response_id?: string;
  model?: string;
  function_name?: string;
  action_class?: string;
  triggers?: string[];
  decision?: "ALLOW" | "HOLD";
  enforced: boolean;
  hold_id?: string;
  args_bytes?: number;
}

/** Per-response token usage — the fuel gauge behind TOKEN_BUDGET. */
export interface UsageEntry {
  type: "usage";
  ts: string;
  model?: string;
  /** First 12 hex chars of the session key hash — correlation, not identity. */
  session?: string;
  tokens_prompt: number;
  tokens_completion: number;
  tokens_total: number;
}

/** A `phinq learn` policy application — policy evolution is chain-recorded. */
export interface PolicyChangeEntry {
  type: "policy_change";
  ts: string;
  source: string;
  changes: {
    tool: string;
    to: string;
    action: string;
    basis: string;
    approvals: number;
    denials: number;
    holds: number;
  }[];
}

/** Every hold state transition, including creation. */
export interface HoldEntry {
  type: "hold_transition";
  ts: string;
  hold_id: string;
  status: string; // PENDING (creation) or the terminal status
  decided_by?: string;
}

export type AuditEntry = (GenesisEntry | DecisionEntry | HoldEntry | UsageEntry | PolicyChangeEntry) & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export class AuditLog {
  private tail: Promise<void> = Promise.resolve();
  private lastHash: string = GENESIS_PREV;
  private warned = false;

  constructor(
    private readonly path: string,
    private readonly logError: (msg: string) => void
  ) {
    // Resume an existing chain (restart) or write the genesis entry.
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) {
        try {
          const parsed = JSON.parse(last) as Record<string, unknown>;
          if (typeof parsed.entry_hash === "string") this.lastHash = parsed.entry_hash;
        } catch {
          this.logError(`audit log tail is unparseable — appends will not chain (${path})`);
        }
      }
    }
    if (this.lastHash === GENESIS_PREV) {
      this.append({
        type: "genesis",
        log_id: randomUUID(),
        created_at: new Date().toISOString(),
      });
    }
  }

  /** Append an entry. Chained, serialized, fail-open (errors logged once). */
  append(entry: AuditEntry): void {
    const prev = this.lastHash;
    const hash = entryHash(prev, entry as Record<string, unknown>);
    this.lastHash = hash;
    const line = JSON.stringify({ ...entry, prev_hash: prev, entry_hash: hash }) + "\n";
    this.tail = this.tail
      .then(() => appendFile(this.path, line, "utf8"))
      .catch((err) => {
        if (!this.warned) {
          this.warned = true;
          this.logError(`audit log write failed (${this.path}): ${String(err)}`);
        }
      });
  }

  flush(): Promise<void> {
    return this.tail;
  }
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  entries: number;
  /** First broken link, when !ok. */
  firstBreak?: { index: number; ts?: string; reason: string };
}

export function verifyChain(lines: string[]): VerifyResult {
  let prev = GENESIS_PREV;
  let index = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, entries: index, firstBreak: { index, reason: "unparseable line" } };
    }
    const { prev_hash, entry_hash, ...entry } = parsed;
    const ts = (entry.ts ?? entry.created_at) as string | undefined;
    if (index === 0 && entry.type !== "genesis") {
      return { ok: false, entries: index, firstBreak: { index, ts, reason: "missing genesis entry" } };
    }
    if (prev_hash !== prev) {
      return {
        ok: false,
        entries: index,
        firstBreak: { index, ts, reason: "prev_hash does not match the preceding entry (modified, reordered, or removed)" },
      };
    }
    const expected = entryHash(prev, entry);
    if (entry_hash !== expected) {
      return {
        ok: false,
        entries: index,
        firstBreak: { index, ts, reason: "entry_hash does not match entry content (entry modified)" },
      };
    }
    prev = entry_hash as string;
    index++;
  }
  return { ok: true, entries: index };
}

export async function verifyFile(path: string): Promise<VerifyResult> {
  const content = await readFile(path, "utf8");
  return verifyChain(content.split("\n"));
}
