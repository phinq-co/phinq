import { classifyToolCall, sessionEventKind, DEFAULT_RULES } from "./classifier.js";
import type { ClassifierRules } from "./classifier.js";
import type { HoldStore } from "./holds.js";
import type { HoldNotifier } from "./slack.js";
import type { AuditLog } from "./audit.js";

/**
 * MCP gateway — wrap any MCP server with the Phinq checkpoint.
 *
 *   agent (MCP client) → phinq-mcp → real MCP server
 *
 * Unlike the HTTP proxy (which inspects the calls a model *proposes*), the
 * gateway sits at the execution boundary: it intercepts `tools/call`
 * requests before the wrapped server runs them.
 *
 *  - ALLOW      → forwarded untouched.
 *  - HOLD (shadow)   → logged + audited, forwarded.
 *  - HOLD (enforce)  → held in the same HoldStore the proxy uses — approve
 *    from the `phinq` CLI, Telegram, or Slack. Denial/timeout returns a
 *    clean `isError` tool result to the agent (not a protocol error), so
 *    the agent can continue.
 *
 * Everything that is not a `tools/call` request (initialize, tools/list,
 * notifications, server→client traffic) relays byte-identically. Framing is
 * newline-delimited JSON-RPC per the MCP stdio transport spec.
 */

export interface McpGatewayOptions {
  rules?: ClassifierRules;
  /** Enforce HOLD decisions. False = shadow (log only). */
  enforce: boolean;
  /** Required when enforcing. */
  holds?: HoldStore | null;
  notifier?: HoldNotifier | null;
  audit?: AuditLog | null;
  holdTimeoutMs: number;
  /** Rolling window (minutes) for velocity triggers. */
  windowMinutes?: number;
  errorWindowMinutes?: number;
  log: (msg: string) => void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

/** Minimal in-process rolling-window counters (one gateway = one session). */
class WindowCounters {
  private events: { kind: "send" | "delete" | "error"; ts: number }[] = [];
  constructor(private windowMs: number, private errorWindowMs: number) {}

  record(kind: "send" | "delete" | "error", now = Date.now()): void {
    this.events.push({ kind, ts: now });
    const cutoff = now - Math.max(this.windowMs, this.errorWindowMs);
    this.events = this.events.filter((e) => e.ts >= cutoff);
  }

  counts(now = Date.now()): { sends: number; deletes: number; recentError: boolean } {
    let sends = 0;
    let deletes = 0;
    let recentError = false;
    for (const e of this.events) {
      if (e.kind === "send" && e.ts >= now - this.windowMs) sends++;
      else if (e.kind === "delete" && e.ts >= now - this.windowMs) deletes++;
      else if (e.kind === "error" && e.ts >= now - this.errorWindowMs) recentError = true;
    }
    return { sends, deletes, recentError };
  }
}

export class McpGateway {
  private readonly counters: WindowCounters;
  /** ids of in-flight tools/call requests, to spot error results coming back. */
  private readonly pendingToolCalls = new Set<string>();

  constructor(private readonly opts: McpGatewayOptions) {
    this.counters = new WindowCounters(
      (opts.windowMinutes ?? 60) * 60_000,
      (opts.errorWindowMinutes ?? 10) * 60_000
    );
  }

  /**
   * Process one client→server line. Calls `toServer` to forward (possibly
   * unchanged), or `toClient` to answer directly (denial). Exactly one of
   * the two is called per message.
   */
  async handleClientLine(
    line: string,
    toServer: (line: string) => void,
    toClient: (line: string) => void
  ): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      toServer(line); // not ours to judge — relay as-is
      return;
    }

    if (msg.method !== "tools/call" || msg.id === undefined || msg.id === null) {
      toServer(line);
      return;
    }

    const params = msg.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    let argumentsJson: string | undefined;
    if (params.arguments !== undefined) {
      try {
        argumentsJson = JSON.stringify(params.arguments);
      } catch {
        argumentsJson = undefined;
      }
    }

    const classification = classifyToolCall(
      { name, argumentsJson },
      this.counters.counts(),
      this.opts.rules ?? DEFAULT_RULES
    );
    const kind = sessionEventKind(name);
    if (kind) this.counters.record(kind);
    this.pendingToolCalls.add(String(msg.id));

    const enforced = this.opts.enforce && classification.decision === "HOLD";
    let holdId: string | undefined;

    if (classification.decision === "HOLD" && this.opts.enforce && this.opts.holds) {
      const { id, outcome } = this.opts.holds.createAndWait({
        responseBody: Buffer.from(line),
        calls: [
          {
            ts: new Date().toISOString(),
            event: "tool_call",
            choice_index: 0,
            call_index: 0,
            function_name: name,
            arguments: argumentsJson ?? "",
            args_parse_ok: argumentsJson !== undefined,
            args_bytes: argumentsJson?.length ?? 0,
            action_class: classification.action_class,
            decision: classification.decision,
            triggers: classification.triggers,
            reasons: classification.reasons,
            unknown_tool: classification.unknown_tool,
          },
        ],
        timeoutMs: this.opts.holdTimeoutMs,
      });
      holdId = id;
      this.audit(name, classification, true, holdId);
      this.opts.log(
        `HOLD ${id} — ${name} [${classification.action_class}] ` +
          `(approve with: phinq approve ${id})`
      );
      void this.opts.notifier?.notifyHold(
        this.opts.holds.get(id)!,
        this.opts.holdTimeoutMs / 1000
      );

      const result = await outcome;
      if (result === "APPROVED") {
        toServer(line);
      } else {
        this.pendingToolCalls.delete(String(msg.id));
        const why =
          result === "DENIED"
            ? "denied by the operator"
            : "not approved within the approval window";
        toClient(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [
                {
                  type: "text",
                  text:
                    `Phinq checkpoint: this call was ${why} and was NOT executed. ` +
                    `Classification: ${classification.action_class}` +
                    (classification.triggers.length
                      ? ` (${classification.triggers.join(", ")})`
                      : "") +
                    ". Continue with a safer approach or ask the operator.",
                },
              ],
              isError: true,
            },
          })
        );
      }
      return;
    }

    // ALLOW, or HOLD in shadow mode.
    this.audit(name, classification, enforced, holdId);
    if (classification.decision === "HOLD") {
      this.opts.log(
        `shadow HOLD — ${name} [${classification.action_class}] passed through (enforce off)`
      );
    }
    toServer(line);
  }

  /**
   * Process one server→client line. Watches tool results for errors (arms
   * the AFTER_ERROR_BULK trigger); everything relays untouched.
   */
  handleServerLine(line: string, toClient: (line: string) => void): void {
    try {
      const msg = JSON.parse(line) as JsonRpcMessage;
      if (msg.id !== undefined && msg.id !== null && this.pendingToolCalls.delete(String(msg.id))) {
        const isError =
          msg.error !== undefined ||
          (msg.result && (msg.result as Record<string, unknown>).isError === true);
        if (isError) this.counters.record("error");
      }
    } catch {
      /* relay regardless */
    }
    toClient(line);
  }

  private audit(
    name: string,
    classification: ReturnType<typeof classifyToolCall>,
    enforced: boolean,
    holdId?: string
  ): void {
    this.opts.audit?.append({
      type: "decision",
      ts: new Date().toISOString(),
      function_name: name,
      action_class: classification.action_class,
      triggers: classification.triggers,
      decision: classification.decision,
      enforced,
      ...(holdId ? { hold_id: holdId } : {}),
    });
  }
}
