import {
  classifyToolCall,
  sessionEventKind,
  DEFAULT_RULES,
  type Classification,
  type ClassifierRules,
  type Decision,
} from "./classifier.js";
import { MemorySessionStore, DEFAULT_WINDOWS, type SessionWindows } from "./session.js";

/** A tool call to govern. `args` may be a structured object or a raw JSON string. */
export interface ToolCall {
  name: string;
  args?: unknown;
}

/** What an approval handler receives when a call is HELD. */
export interface HoldRequest {
  name: string;
  args: unknown;
  classification: Classification;
  sessionKey: string;
}

/** Operator verdict for a held call. */
export type Verdict = "approve" | "deny";

export interface GateContext {
  /** Groups velocity counters (e.g. an agent id). Defaults to a single session. */
  sessionKey?: string;
  /**
   * Called when a call is HELD. Return "approve" to let it run, "deny" to block.
   * Omit it and held calls fall back to {@link PhinqConfig.defaultOnHold}.
   */
  onHold?: (req: HoldRequest) => Verdict | Promise<Verdict>;
  /** Auto-deny if the handler doesn't answer in time. Overrides the config default. */
  holdTimeoutMs?: number;
}

export type GateResolution = "allowed" | "approved" | "denied" | "timed_out";

export interface GateResult {
  /** The single thing the caller must honor: run the tool or not. */
  allowed: boolean;
  decision: Decision;
  classification: Classification;
  resolution: GateResolution;
}

export interface AuditEntry {
  ts: string;
  name: string;
  action_class: string;
  decision: Decision;
  triggers: string[];
  allowed: boolean;
  resolution: GateResolution;
  /** Byte length of the serialized arguments — never the arguments themselves. */
  args_bytes: number;
}

export interface PhinqConfig {
  /** Thresholds + tool→class overrides. Defaults to the standard rule set. */
  rules?: ClassifierRules;
  /** Rolling-window sizes for velocity triggers. */
  windows?: SessionWindows;
  /** What to do with a HELD call when no `onHold` handler is supplied. Default "deny". */
  defaultOnHold?: Verdict;
  /** Default auto-deny timeout for `onHold`. Default 240_000 ms (matches the proxy). */
  holdTimeoutMs?: number;
  /** Optional sink for one entry per governed call. Arguments are never included. */
  onAudit?: (entry: AuditEntry) => void;
}

/**
 * In-process governance for a TS agent. Wraps the same deterministic classifier
 * the Phinq proxy uses, adds rolling-window velocity tracking, and gates a tool
 * call on an operator verdict — all without a network hop. Unlike the proxy
 * (which intercepts the model's *proposed* call), `gate()` sits at the point of
 * *actual execution*, so a denial cannot be worked around by the agent.
 */
export class PhinqGovernor {
  private readonly rules: ClassifierRules;
  private readonly sessions: MemorySessionStore;
  private readonly defaultOnHold: Verdict;
  private readonly holdTimeoutMs: number;
  private readonly onAudit?: (entry: AuditEntry) => void;

  constructor(config: PhinqConfig = {}) {
    this.rules = config.rules ?? DEFAULT_RULES;
    this.sessions = new MemorySessionStore(config.windows ?? DEFAULT_WINDOWS);
    this.defaultOnHold = config.defaultOnHold ?? "deny";
    this.holdTimeoutMs = config.holdTimeoutMs ?? 240_000;
    this.onAudit = config.onAudit;
  }

  /** Classify without recording or gating — pure inspection of a single call. */
  classify(call: ToolCall, sessionKey = "default"): Classification {
    return classifyToolCall(
      { name: call.name, argumentsJson: serializeArgs(call.args) },
      this.sessions.counts(sessionKey),
      this.rules
    );
  }

  /**
   * Classify, record velocity, and resolve a verdict. Returns `allowed`: honor
   * it by running or skipping the tool. ALLOW resolves instantly; HOLD consults
   * `onHold` (or the configured default), auto-denying on timeout.
   */
  async gate(call: ToolCall, ctx: GateContext = {}): Promise<GateResult> {
    const sessionKey = ctx.sessionKey ?? "default";
    const counts = this.sessions.counts(sessionKey);
    const classification = classifyToolCall(
      { name: call.name, argumentsJson: serializeArgs(call.args) },
      counts,
      this.rules
    );

    // Record this call's velocity contribution for subsequent calls in the window.
    const kind = sessionEventKind(call.name);
    if (kind) this.sessions.record(sessionKey, kind);

    let allowed: boolean;
    let resolution: GateResolution;

    if (classification.decision === "ALLOW") {
      allowed = true;
      resolution = "allowed";
    } else if (!ctx.onHold) {
      allowed = this.defaultOnHold === "approve";
      resolution = allowed ? "approved" : "denied";
    } else {
      const verdict = await withTimeout(
        Promise.resolve(ctx.onHold({ name: call.name, args: call.args, classification, sessionKey })),
        ctx.holdTimeoutMs ?? this.holdTimeoutMs
      );
      allowed = verdict === "approve";
      resolution = verdict === "approve" ? "approved" : verdict === "deny" ? "denied" : "timed_out";
    }

    const result: GateResult = { allowed, decision: classification.decision, classification, resolution };
    this.onAudit?.({
      ts: new Date().toISOString(),
      name: call.name,
      action_class: classification.action_class,
      decision: classification.decision,
      triggers: classification.triggers,
      allowed,
      resolution,
      args_bytes: serializeArgs(call.args)?.length ?? 0,
    });
    return result;
  }
}

/** Stringify structured args for the arg-inspecting classifier; pass strings through. */
export function serializeArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

/** Resolve the verdict, or "timeout" if it doesn't arrive in time. */
async function withTimeout(
  p: Promise<Verdict>,
  ms: number
): Promise<Verdict | "timeout"> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
