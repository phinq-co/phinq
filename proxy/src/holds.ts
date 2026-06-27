import { createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ObservedToolCall } from "./toolcalls.js";

/**
 * Component 4 — hold queue (PROXY-MVP.md, day 9–11).
 *
 * When a response classifies HOLD (any tool call — the hold is atomic for the
 * whole response), the original upstream bytes are parked here, the agent's
 * HTTP request stays open (long-poll), and the operator decides via Telegram.
 *
 * Timeout contract: the hold window must end before the agent's own client
 * gives up (Hermes stale detector: 300s stock), so the default is 240s and
 * config warns above that.
 *
 * State machine (terminal states are final — first decision wins):
 *   PENDING → APPROVED          original response released
 *   PENDING → DENIED            synthetic denial returned
 *   PENDING → EXPIRED_TIMEOUT   no decision in time → synthetic denial
 *   PENDING → EXPIRED_CLIENT    agent hung up first → nothing returned,
 *                               late approvals get "arrived late"
 */

export type HoldStatus =
  | "PENDING"
  | "APPROVED"
  | "DENIED"
  | "EXPIRED_TIMEOUT"
  | "EXPIRED_CLIENT";

export type HoldOutcome = Exclude<HoldStatus, "PENDING">;

export interface HoldRecord {
  id: string;
  created_at: number;
  timeout_at: number;
  status: HoldStatus;
  decided_at?: number;
  decided_by?: string;
  model?: string;
  response_id?: string;
  response_body: Buffer;
  calls: ObservedToolCall[];
  telegram_message_id?: number;
}

export interface DecideResult {
  /** applied = this decision resolved the hold; already = a terminal decision
   *  existed; late = hold expired before the decision arrived; unknown = no
   *  such hold. */
  result: "applied" | "already" | "late" | "unknown";
  status?: HoldStatus;
}

export class HoldStore {
  private db: DatabaseSync;
  private waiters = new Map<string, (outcome: HoldOutcome) => void>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Called on every terminal transition (Telegram edits, audit entries…). */
  private transitionListeners: ((hold: HoldRecord) => void)[] = [];

  addTransitionListener(fn: (hold: HoldRecord) => void): void {
    this.transitionListeners.push(fn);
  }

  constructor(
    path: string,
    private readonly log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS holds (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        timeout_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        model TEXT,
        response_id TEXT,
        response_body BLOB NOT NULL,
        calls_json TEXT NOT NULL,
        telegram_message_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);

    // Proxy restart: any PENDING hold's client connection is gone. The held
    // action was never executed; record that truthfully.
    const orphans = this.db
      .prepare("SELECT id FROM holds WHERE status = 'PENDING'")
      .all() as { id: string }[];
    for (const { id } of orphans) {
      this.transition(id, "EXPIRED_CLIENT", "startup_recovery");
    }
    if (orphans.length > 0) {
      this.log.warn({ count: orphans.length }, "pending holds expired on restart (client gone)");
    }
  }

  /** Per-install HMAC secret for Telegram callback authentication. */
  installSecret(): string {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = 'install_secret'").get() as
      | { v: string }
      | undefined;
    if (row) return row.v;
    const secret = randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO meta (k, v) VALUES ('install_secret', ?)").run(secret);
    return secret;
  }

  /** HMAC tag binding a hold id to a decision; truncated to fit Telegram's
   *  64-byte callback_data limit. */
  callbackTag(holdId: string, decision: "approve" | "deny"): string {
    return createHmac("sha256", this.installSecret())
      .update(`${holdId}:${decision}`)
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * Park a response and wait for the outcome. The returned promise resolves
   * with the terminal status: on APPROVED the caller releases `responseBody`
   * verbatim; on DENIED/EXPIRED_TIMEOUT the caller sends a synthetic denial;
   * on EXPIRED_CLIENT the connection is already gone.
   */
  createAndWait(args: {
    responseBody: Buffer;
    calls: ObservedToolCall[];
    timeoutMs: number;
    model?: string;
    responseId?: string;
  }): { id: string; outcome: Promise<HoldOutcome> } {
    const id = randomBytes(6).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO holds (id, created_at, timeout_at, status, model, response_id, response_body, calls_json)
         VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?)`
      )
      .run(
        id,
        now,
        now + args.timeoutMs,
        args.model ?? null,
        args.responseId ?? null,
        new Uint8Array(args.responseBody),
        JSON.stringify(args.calls)
      );

    const outcome = new Promise<HoldOutcome>((resolve) => {
      this.waiters.set(id, resolve);
    });

    const timer = setTimeout(() => {
      this.transition(id, "EXPIRED_TIMEOUT", "timeout");
    }, args.timeoutMs);
    timer.unref();
    this.timers.set(id, timer);

    this.log.info(
      { hold_id: id, calls: args.calls.map((c) => c.function_name), timeout_ms: args.timeoutMs },
      "response held"
    );
    return { id, outcome };
  }

  /** Operator decision from Telegram (HMAC already verified by the caller). */
  decide(holdId: string, decision: "approve" | "deny", decidedBy: string): DecideResult {
    const hold = this.get(holdId);
    if (!hold) return { result: "unknown" };
    if (hold.status === "PENDING") {
      const status: HoldOutcome = decision === "approve" ? "APPROVED" : "DENIED";
      this.transition(holdId, status, decidedBy);
      return { result: "applied", status };
    }
    if (hold.status === "EXPIRED_TIMEOUT" || hold.status === "EXPIRED_CLIENT") {
      return { result: "late", status: hold.status };
    }
    return { result: "already", status: hold.status };
  }

  /** The agent's HTTP connection closed before a decision. */
  clientClosed(holdId: string): void {
    const hold = this.get(holdId);
    if (hold?.status === "PENDING") {
      this.transition(holdId, "EXPIRED_CLIENT", "client_close");
    }
  }

  setTelegramMessageId(holdId: string, messageId: number): void {
    this.db
      .prepare("UPDATE holds SET telegram_message_id = ? WHERE id = ?")
      .run(messageId, holdId);
  }

  /** Pending holds awaiting a decision, oldest first (for local approval UI). */
  listPending(): HoldRecord[] {
    const rows = this.db
      .prepare("SELECT id FROM holds WHERE status = 'PENDING' ORDER BY created_at ASC")
      .all() as { id: string }[];
    return rows.map((r) => this.get(r.id)).filter((h): h is HoldRecord => h !== null);
  }

  get(holdId: string): HoldRecord | null {
    const row = this.db.prepare("SELECT * FROM holds WHERE id = ?").get(holdId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      created_at: row.created_at as number,
      timeout_at: row.timeout_at as number,
      status: row.status as HoldStatus,
      decided_at: (row.decided_at as number) ?? undefined,
      decided_by: (row.decided_by as string) ?? undefined,
      model: (row.model as string) ?? undefined,
      response_id: (row.response_id as string) ?? undefined,
      response_body: Buffer.from(row.response_body as Uint8Array),
      calls: JSON.parse(row.calls_json as string),
      telegram_message_id: (row.telegram_message_id as number) ?? undefined,
    };
  }

  private transition(holdId: string, status: HoldOutcome, decidedBy: string): void {
    // First decision wins: the guarded UPDATE is the atomic arbiter.
    const changed = this.db
      .prepare("UPDATE holds SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'PENDING'")
      .run(status, Date.now(), decidedBy, holdId);
    if (changed.changes === 0) return;

    const timer = this.timers.get(holdId);
    if (timer) clearTimeout(timer);
    this.timers.delete(holdId);

    const waiter = this.waiters.get(holdId);
    this.waiters.delete(holdId);
    waiter?.(status);

    this.log.info({ hold_id: holdId, status, decided_by: decidedBy }, "hold resolved");
    const hold = this.get(holdId);
    if (hold) for (const listener of this.transitionListeners) listener(hold);
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    // Anything still pending at shutdown: the client is about to lose us.
    for (const id of [...this.waiters.keys()]) {
      this.transition(id, "EXPIRED_CLIENT", "shutdown");
    }
    this.db.close();
  }
}

/**
 * Synthetic denial (spec decision #4): a valid chat completion mirroring id,
 * model, and usage from the held response. Plain assistant message,
 * finish_reason "stop", NO tool_calls key — the agent never saw the held
 * call, so no dangling tool_call_id exists.
 */
export function syntheticDenial(heldBody: Buffer, reason: "denied" | "timeout"): Buffer {
  let held: Record<string, unknown> = {};
  try {
    held = JSON.parse(heldBody.toString("utf8"));
  } catch {
    /* held body should always be JSON, but the denial must never fail */
  }
  const content =
    reason === "denied"
      ? "This action was held by Phinq governance and denied by the operator. Do not retry it in another form. Continue with the remaining task."
      : "This action was held by Phinq governance and the approval window expired with no operator response. Do not retry it in another form. Continue with the remaining task.";
  const denial: Record<string, unknown> = {
    id: held.id ?? `phinq-denial-${Date.now()}`,
    object: "chat.completion",
    created: held.created ?? Math.floor(Date.now() / 1000),
    model: held.model ?? "unknown",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
  if (held.usage) denial.usage = held.usage;
  return Buffer.from(JSON.stringify(denial), "utf8");
}
