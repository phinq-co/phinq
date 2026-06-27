/**
 * @phinq/governance — in-process governance for TypeScript AI agents.
 *
 * The same deterministic decision engine as the Phinq proxy, as a library you
 * import instead of a proxy you route through. Classify a tool call, gate it on
 * an operator verdict at the point of execution, and audit every decision.
 */
export { PhinqGovernor, serializeArgs } from "./governor.js";
export type {
  ToolCall,
  HoldRequest,
  Verdict,
  GateContext,
  GateResolution,
  GateResult,
  AuditEntry,
  PhinqConfig,
} from "./governor.js";

export { MemorySessionStore, DEFAULT_WINDOWS, sessionKeyFrom } from "./session.js";
export type { SessionWindows } from "./session.js";

// Re-export the shared classifier surface so consumers can inspect/tune rules.
export {
  classifyToolCall,
  sessionEventKind,
  maxClass,
  AgentActionClass,
  DEFAULT_RULES,
  DEFAULT_THRESHOLDS,
} from "./classifier.js";
export type {
  Classification,
  Decision,
  StructuralTrigger,
  SessionCounts,
  ClassifierRules,
  ClassifierThresholds,
} from "./classifier.js";
