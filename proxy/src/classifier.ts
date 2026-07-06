/**
 * Component 3 — deterministic classifier (PROXY-MVP.md, day 5–8).
 *
 * Ports the Phinq governance model to the proxy layer:
 *  - Action classes from the phinq-governance skill (action-classes.md):
 *    RISK_REDUCING < REVERSIBLE < IRREVERSIBLE_LOW < IRREVERSIBLE_MEDIUM
 *    < IRREVERSIBLE_HIGH.
 *  - Structural triggers from the skill spec (triggers.md): always escalate
 *    to IRREVERSIBLE_HIGH regardless of base class. Thresholds are operator-
 *    tunable via phinq.yaml; the categories are not.
 *  - Decision output is ALLOW or HOLD only (MVP — no L0–L5 ladder).
 *
 * Pure and deterministic: same call + same session counts → same decision.
 * No network, no clock reads (the caller passes session counts in).
 */

export enum AgentActionClass {
  RISK_REDUCING = "RISK_REDUCING",
  REVERSIBLE = "REVERSIBLE",
  IRREVERSIBLE_LOW = "IRREVERSIBLE_LOW",
  IRREVERSIBLE_MEDIUM = "IRREVERSIBLE_MEDIUM",
  IRREVERSIBLE_HIGH = "IRREVERSIBLE_HIGH",
}

const CLASS_ORDER: AgentActionClass[] = [
  AgentActionClass.RISK_REDUCING,
  AgentActionClass.REVERSIBLE,
  AgentActionClass.IRREVERSIBLE_LOW,
  AgentActionClass.IRREVERSIBLE_MEDIUM,
  AgentActionClass.IRREVERSIBLE_HIGH,
];

export function maxClass(a: AgentActionClass, b: AgentActionClass): AgentActionClass {
  return CLASS_ORDER.indexOf(a) >= CLASS_ORDER.indexOf(b) ? a : b;
}

/** Structural triggers — the seven non-negotiable categories from triggers.md. */
export type StructuralTrigger =
  | "BULK_DELETE"
  | "CREDENTIAL_ACCESS"
  | "DISABLE_SAFEGUARDS"
  | "EXTERNAL_COMM_VOLUME"
  | "PERMISSION_ESCALATION"
  | "BILLING_MODIFICATION"
  | "AFTER_ERROR_BULK"
  | "TOKEN_BUDGET";

export type Decision = "ALLOW" | "HOLD";

/** Rolling-window counts for the calling session (see session.ts). */
export interface SessionCounts {
  /** Outbound communications already sent in the window (this call excluded). */
  sends: number;
  /** Delete-class operations already performed in the window (this call excluded). */
  deletes: number;
  /** Whether an error occurred in this session within the error window. */
  recentError: boolean;
  /** Tokens consumed in the window before this call (usage-block accounting). */
  windowTokens?: number;
}

export interface ClassifierThresholds {
  /** EXTERNAL_COMM_VOLUME fires when sends in the window exceed this. Default 3. */
  externalCommVolume: number;
  /** BULK_DELETE fires when deletes (or items in one call) exceed this. Default 5. */
  bulkDeleteCount: number;
  /**
   * TOKEN_BUDGET fires when session token use exceeds this. 0 disables
   * (default) — token regulation is opt-in so routine sessions never
   * false-HOLD.
   */
  sessionTokenBudget: number;
}

export const DEFAULT_THRESHOLDS: ClassifierThresholds = {
  externalCommVolume: 3,
  bulkDeleteCount: 5,
  sessionTokenBudget: 0,
};

export interface ClassifierRules {
  thresholds: ClassifierThresholds;
  /**
   * Operator overrides: exact tool name → class. Overrides the name-pattern
   * base class; structural triggers still apply on top.
   */
  toolClassOverrides: Record<string, AgentActionClass>;
}

export const DEFAULT_RULES: ClassifierRules = {
  thresholds: DEFAULT_THRESHOLDS,
  toolClassOverrides: {},
};

export interface Classification {
  action_class: AgentActionClass;
  decision: Decision;
  triggers: StructuralTrigger[];
  /** Human-readable reasons, one per rule that fired. */
  reasons: string[];
  /** True when no rule recognized the tool name — calibration signal. */
  unknown_tool: boolean;
}

// ---------------------------------------------------------------------------
// Name-pattern base classes
// ---------------------------------------------------------------------------

interface NameRule {
  pattern: RegExp;
  cls: AgentActionClass;
  trigger?: StructuralTrigger;
  kind?: "send" | "delete" | "shell";
  reason: string;
}

/**
 * Ordered, but ALL matching rules apply and the highest class wins — a tool
 * named delete_credentials must hit both the delete and credential rules.
 */
// NOTE: \b does not fire inside snake_case (underscore is a word character),
// so short tokens use explicit (^|[_\W])…([_\W]|$) boundaries instead.
const NAME_RULES: NameRule[] = [
  {
    pattern: /credential|secret|token|api[_-]?key|keychain|vault|dotenv|(^|[_\W])env([_\W]|$)/i,
    cls: AgentActionClass.IRREVERSIBLE_HIGH,
    trigger: "CREDENTIAL_ACCESS",
    reason: "tool name references credential/secret storage",
  },
  {
    pattern: /billing|payment|charge|subscri|invoice|refund|payout|checkout/i,
    cls: AgentActionClass.IRREVERSIBLE_HIGH,
    trigger: "BILLING_MODIFICATION",
    reason: "tool name references billing/payment state",
  },
  {
    pattern: /sudo|chmod|chown|setcap|escalat/i,
    cls: AgentActionClass.IRREVERSIBLE_HIGH,
    trigger: "PERMISSION_ESCALATION",
    reason: "tool name references permission/capability change",
  },
  {
    pattern: /delete|remove|(^|[_\W])rm([_\W]|$)|drop|destroy|purge|truncate|wipe|erase/i,
    cls: AgentActionClass.IRREVERSIBLE_MEDIUM,
    kind: "delete",
    reason: "tool name is a delete-class operation",
  },
  {
    pattern: /send|email|message|publish|tweet|(^|[_\W])dm([_\W]|$)|broadcast|outreach|reply|post_/i,
    cls: AgentActionClass.IRREVERSIBLE_LOW,
    kind: "send",
    reason: "tool name is an outbound communication",
  },
  {
    pattern: /^(get|list|read|search|fetch|view|query|describe|stat|browse|find|check)[_-]?/i,
    cls: AgentActionClass.REVERSIBLE,
    reason: "tool name is a read-only operation",
  },
  {
    pattern: /write|create|update|edit|move|rename|upload|insert|append|save/i,
    cls: AgentActionClass.REVERSIBLE,
    reason: "tool name is a workspace write (operator-recoverable)",
  },
  {
    pattern: /shell|exec|bash|terminal|command|(^|[_\W])run([_\W]|$)|subprocess|script/i,
    cls: AgentActionClass.REVERSIBLE,
    kind: "shell",
    reason: "tool name is a shell/exec surface — arguments inspected",
  },
  {
    pattern: /undo|revert|rollback|restore|cancel|halt|stop|abort|pause/i,
    cls: AgentActionClass.RISK_REDUCING,
    reason: "tool name reduces or undoes risk",
  },
];

// ---------------------------------------------------------------------------
// Argument inspection
// ---------------------------------------------------------------------------

interface ArgFinding {
  cls: AgentActionClass;
  trigger?: StructuralTrigger;
  reason: string;
}

const SHELL_PATTERNS: { pattern: RegExp; finding: ArgFinding }[] = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+|--force|--recursive)/,
    finding: {
      cls: AgentActionClass.IRREVERSIBLE_HIGH,
      trigger: "BULK_DELETE",
      reason: "shell command contains recursive/forced rm",
    },
  },
  {
    pattern: /\bsudo\b/,
    finding: {
      cls: AgentActionClass.IRREVERSIBLE_HIGH,
      trigger: "PERMISSION_ESCALATION",
      reason: "shell command uses sudo",
    },
  },
  {
    pattern: /\b(chmod|chown|setcap)\b/,
    finding: {
      cls: AgentActionClass.IRREVERSIBLE_HIGH,
      trigger: "PERMISSION_ESCALATION",
      reason: "shell command changes permissions/ownership",
    },
  },
  {
    pattern: /\b(curl|wget)\b[^|;&]*\|\s*(ba|z|da)?sh\b/,
    finding: {
      cls: AgentActionClass.IRREVERSIBLE_HIGH,
      trigger: "PERMISSION_ESCALATION",
      reason: "shell command pipes a download into a shell",
    },
  },
  {
    pattern: /(^|[\s/"'=])\.env\b|\bid_rsa\b|\.pem\b|secrets?[./]|credentials?[./]/,
    finding: {
      cls: AgentActionClass.IRREVERSIBLE_HIGH,
      trigger: "CREDENTIAL_ACCESS",
      reason: "shell command touches credential/secret files",
    },
  },
  {
    pattern: /git\s+push\s[^|;&]*(--force|-f\b)/,
    finding: {
      cls: AgentActionClass.IRREVERSIBLE_MEDIUM,
      reason: "force-push rewrites remote history",
    },
  },
];

/**
 * References to the governance layer itself → DISABLE_SAFEGUARDS. Covers the
 * policy (phinq.yaml/.env), the audit chain + corpus, the hold/session state,
 * AND the phinq-governance skill definition. An agent must not be able to
 * quietly read, edit, or delete the rules that constrain it — self-modification
 * of the safety net is held the same as deleting the audit log. Matched against
 * every argument string, so a tool arg like {"name":"phinq-governance"} counts.
 */
const SAFEGUARD_PATHS =
  /phinq\.ya?ml|phinq\.env|phinq[-_]config|phinq[-_]toolcalls|phinq[-_]?audit|audit.*\.jsonl|phinq[-_]holds|phinq[-_]session|phinq[-_]governance|(^|[\s/\\"'=([])\.phinq(?=[/\\"'\s)\]]|$)/i;

// Reading the governance layer is recon, not tampering; only *mutating* it is
// held. These split a call that references a governance path into read vs write.
// Verbs are matched anywhere in the tool name so Hermes-style names work
// (skill_view, memory_get). A name carrying BOTH a read and a write verb is
// treated as a write (a mutation that happens to read first).
const SAFEGUARD_READ_NAME =
  /(^|[_\W])(read|view|search|list|get|fetch|query|describe|stat|browse|find|check|inspect|show|preview|open|cat|grep|head|tail|ls|wc)([_\W]|$)/i;
const SAFEGUARD_WRITE_NAME =
  /(^|[_\W])(write|edit|patch|delete|remove|rm|update|create|manage|set|apply|move|rename|append|save|replace|insert|upload|modify|put|post|truncate|drop)([_\W]|$)/i;
// A shell command that MUTATES a path: a destructive command token, an in-place
// sed, or a real `>`/`>>` redirect. The `(?<![\d&])` guard excludes fd
// redirects (`2>/dev/null`, `2>&1`) so read commands that discard stderr pass.
const SHELL_MUTATES_SAFEGUARD =
  /(^|[\s;&|(])(rm|rmdir|unlink|shred|mv|dd|truncate|tee|install|chmod|chown|ln|cp)(\s|$)|(^|[\s;&|(])sed\s+-[a-z]*i|(?<![\d&])>>?\s*[^\s&]/i;

/** Argument keys that carry recipients for outbound communications. */
const RECIPIENT_KEYS = ["to", "recipients", "emails", "cc", "bcc", "targets"];

function countRecipients(args: Record<string, unknown>): number {
  let n = 0;
  for (const key of RECIPIENT_KEYS) {
    const v = args[key];
    if (Array.isArray(v)) n += v.length;
    else if (typeof v === "string" && v.trim()) n += v.split(/[,;]/).filter((s) => s.trim()).length;
  }
  return n;
}

/** Best-effort count of items a single call operates on (ids/paths/files arrays). */
function countItems(args: Record<string, unknown>): number {
  let max = 0;
  for (const v of Object.values(args)) {
    if (Array.isArray(v)) max = Math.max(max, v.length);
  }
  return max;
}

function allStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out, depth + 1);
  else if (typeof value === "object" && value !== null)
    for (const v of Object.values(value)) allStrings(v, out, depth + 1);
  return out;
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

export function classifyToolCall(
  call: { name?: string; argumentsJson?: string },
  session: SessionCounts,
  rules: ClassifierRules = DEFAULT_RULES
): Classification {
  const name = call.name ?? "";
  const reasons: string[] = [];
  const triggers = new Set<StructuralTrigger>();
  let cls: AgentActionClass | null = null; // derived only from matched rules
  let isSend = false;
  let isDelete = false;
  let isShell = false;

  // 1. Name patterns — every matching rule applies, highest class wins.
  for (const rule of NAME_RULES) {
    if (!rule.pattern.test(name)) continue;
    cls = cls === null ? rule.cls : maxClass(cls, rule.cls);
    if (rule.trigger) triggers.add(rule.trigger);
    if (rule.kind === "send") isSend = true;
    if (rule.kind === "delete") isDelete = true;
    if (rule.kind === "shell") isShell = true;
    reasons.push(rule.reason);
  }

  // Operator override replaces the name-derived base class entirely.
  const override = rules.toolClassOverrides[name];
  if (override) {
    cls = override;
    reasons.push(`operator override: ${name} → ${override}`);
  }

  // Unknown tool: not recognized by any rule. The skill says "err one class
  // higher", but a zero-false-HOLD MVP allows it flagged at IRREVERSIBLE_LOW —
  // visible in the corpus, not blocking. Calibration promotes real risks.
  const unknown = cls === null;
  if (cls === null) {
    cls = AgentActionClass.IRREVERSIBLE_LOW;
    reasons.push("unrecognized tool name — flagged for calibration");
  }

  // 2. Argument inspection.
  let args: Record<string, unknown> | null = null;
  if (call.argumentsJson) {
    try {
      const parsed = JSON.parse(call.argumentsJson);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) args = parsed;
    } catch {
      // Unparseable arguments on a recognized risky surface: stay at the
      // name-derived class; the corpus records args_parse_ok=false.
    }
  }

  if (args) {
    const strings = allStrings(args);
    const joined = strings.join("\n");

    if (isShell) {
      for (const { pattern, finding } of SHELL_PATTERNS) {
        if (pattern.test(joined)) {
          cls = maxClass(cls, finding.cls);
          if (finding.trigger) triggers.add(finding.trigger);
          reasons.push(finding.reason);
        }
      }
    }

    if (SAFEGUARD_PATHS.test(joined)) {
      // Only a mutation of the governance layer is held. Writes/edits/deletes
      // and destructive shell commands escalate; a pure read (read_file,
      // skill_view, search, `cat`/`ls`/`wc`, `npm run replay`) passes. This is
      // structural — deliberately NOT relaxable via phinq.yaml.
      const nameLooksRead =
        SAFEGUARD_READ_NAME.test(name) && !SAFEGUARD_WRITE_NAME.test(name);
      const mutatesSafeguard = isShell
        ? SHELL_MUTATES_SAFEGUARD.test(joined)
        : isDelete || !nameLooksRead;
      if (mutatesSafeguard) {
        cls = AgentActionClass.IRREVERSIBLE_HIGH;
        triggers.add("DISABLE_SAFEGUARDS");
        reasons.push("arguments modify Phinq governance files");
      } else {
        reasons.push("read-only access to Phinq governance files");
      }
    }

    if (isSend) {
      const recipients = countRecipients(args);
      if (recipients > 1) {
        cls = maxClass(cls, AgentActionClass.IRREVERSIBLE_MEDIUM);
        reasons.push(`outbound communication to ${recipients} recipients`);
      }
      if (recipients > rules.thresholds.externalCommVolume) {
        cls = AgentActionClass.IRREVERSIBLE_HIGH;
        triggers.add("EXTERNAL_COMM_VOLUME");
        reasons.push(`single call exceeds ${rules.thresholds.externalCommVolume} recipients`);
      }
    }

    if (isDelete) {
      const items = countItems(args);
      if (items > rules.thresholds.bulkDeleteCount) {
        cls = AgentActionClass.IRREVERSIBLE_HIGH;
        triggers.add("BULK_DELETE");
        reasons.push(`single call deletes ${items} items`);
      }
    }
  }

  // 3. Session-window structural triggers.
  if (isSend && session.sends + 1 > rules.thresholds.externalCommVolume) {
    cls = AgentActionClass.IRREVERSIBLE_HIGH;
    triggers.add("EXTERNAL_COMM_VOLUME");
    reasons.push(
      `session send count ${session.sends + 1} exceeds ${rules.thresholds.externalCommVolume}`
    );
  }
  if (isDelete && session.deletes + 1 > rules.thresholds.bulkDeleteCount) {
    cls = AgentActionClass.IRREVERSIBLE_HIGH;
    triggers.add("BULK_DELETE");
    reasons.push(
      `session delete count ${session.deletes + 1} exceeds ${rules.thresholds.bulkDeleteCount}`
    );
  }
  if (
    rules.thresholds.sessionTokenBudget > 0 &&
    (session.windowTokens ?? 0) > rules.thresholds.sessionTokenBudget
  ) {
    cls = AgentActionClass.IRREVERSIBLE_HIGH;
    triggers.add("TOKEN_BUDGET");
    reasons.push(
      `session token use ${session.windowTokens} exceeds budget ${rules.thresholds.sessionTokenBudget}`
    );
  }
  if (
    session.recentError &&
    (triggers.has("BULK_DELETE") || triggers.has("EXTERNAL_COMM_VOLUME"))
  ) {
    triggers.add("AFTER_ERROR_BULK");
    reasons.push("bulk operation within the error window of a prior failure");
  }

  // 4. Decision: MEDIUM and HIGH hold; structural triggers always hold.
  const decision: Decision =
    triggers.size > 0 ||
    cls === AgentActionClass.IRREVERSIBLE_MEDIUM ||
    cls === AgentActionClass.IRREVERSIBLE_HIGH
      ? "HOLD"
      : "ALLOW";

  return {
    action_class: cls,
    decision,
    triggers: [...triggers],
    reasons,
    unknown_tool: unknown,
  };
}

/** Whether a classified call counts as a send/delete for session windows. */
export function sessionEventKind(name: string | undefined): "send" | "delete" | null {
  if (!name) return null;
  for (const rule of NAME_RULES) {
    if (rule.kind === "send" && rule.pattern.test(name)) return "send";
    if (rule.kind === "delete" && rule.pattern.test(name)) return "delete";
  }
  return null;
}
