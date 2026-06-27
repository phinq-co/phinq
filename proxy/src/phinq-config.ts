import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  AgentActionClass,
  DEFAULT_THRESHOLDS,
  type ClassifierRules,
} from "./classifier.js";
import { DEFAULT_WINDOWS, type SessionWindows } from "./session.js";

/**
 * phinq.yaml — operator overrides for the classifier (PROXY-MVP.md §3).
 * Zero-config works: a missing file yields all defaults.
 *
 *   thresholds:
 *     external_comm_volume: 3      # sends per session window before HOLD
 *     bulk_delete_count: 5         # deletes per window / items per call
 *   session:
 *     window_minutes: 60
 *     error_window_minutes: 10
 *   tools:                          # exact tool name → action class
 *     send_newsletter: IRREVERSIBLE_MEDIUM
 *     read_inbox: REVERSIBLE
 *   hold:                           # component 4 (env vars win over these)
 *     enforce: true                 # default false = shadow mode
 *     timeout_seconds: 240          # >240 warns (Hermes stale detector)
 *   telegram:
 *     operator_chat_id: "123456789" # bot token is env-only, never YAML
 */

export interface PhinqRulesConfig {
  rules: ClassifierRules;
  windows: SessionWindows;
  hold: { enforce?: boolean; timeoutSeconds?: number };
  telegram: { operatorChatId?: string };
}

export function defaultPhinqRules(): PhinqRulesConfig {
  return {
    rules: { thresholds: { ...DEFAULT_THRESHOLDS }, toolClassOverrides: {} },
    windows: { ...DEFAULT_WINDOWS },
    hold: {},
    telegram: {},
  };
}

export function loadPhinqRules(
  path: string,
  warn: (msg: string) => void = () => {}
): PhinqRulesConfig {
  const out = defaultPhinqRules();

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out; // no file → defaults
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    warn(`phinq.yaml is not valid YAML — using defaults (${String(err)})`);
    return out;
  }
  if (typeof doc !== "object" || doc === null) return out;
  const d = doc as Record<string, unknown>;

  const thresholds = d.thresholds as Record<string, unknown> | undefined;
  if (thresholds) {
    const n = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
    out.rules.thresholds.externalCommVolume =
      n(thresholds.external_comm_volume) ?? out.rules.thresholds.externalCommVolume;
    out.rules.thresholds.bulkDeleteCount =
      n(thresholds.bulk_delete_count) ?? out.rules.thresholds.bulkDeleteCount;
  }

  const session = d.session as Record<string, unknown> | undefined;
  if (session) {
    const n = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
    out.windows.windowMinutes = n(session.window_minutes) ?? out.windows.windowMinutes;
    out.windows.errorWindowMinutes =
      n(session.error_window_minutes) ?? out.windows.errorWindowMinutes;
  }

  const hold = d.hold as Record<string, unknown> | undefined;
  if (hold) {
    if (typeof hold.enforce === "boolean") out.hold.enforce = hold.enforce;
    if (typeof hold.timeout_seconds === "number" && hold.timeout_seconds > 0) {
      out.hold.timeoutSeconds = Math.floor(hold.timeout_seconds);
    }
  }

  const telegram = d.telegram as Record<string, unknown> | undefined;
  if (telegram && (typeof telegram.operator_chat_id === "string" || typeof telegram.operator_chat_id === "number")) {
    out.telegram.operatorChatId = String(telegram.operator_chat_id);
  }

  const tools = d.tools as Record<string, unknown> | undefined;
  if (tools) {
    const valid = new Set(Object.values(AgentActionClass));
    for (const [tool, cls] of Object.entries(tools)) {
      if (typeof cls === "string" && valid.has(cls as AgentActionClass)) {
        out.rules.toolClassOverrides[tool] = cls as AgentActionClass;
      } else {
        warn(`phinq.yaml: ignoring tools.${tool} — "${String(cls)}" is not a valid action class`);
      }
    }
  }

  return out;
}
