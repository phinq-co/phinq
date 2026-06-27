/**
 * Replay a tool-call corpus (phinq-toolcalls.jsonl) through the classifier.
 *
 * This is how component 3's definition of done is checked: replaying a day of
 * real traffic must produce zero false HOLDs on routine operations. Run after
 * editing phinq.yaml to see how threshold changes would have classified the
 * same traffic — no live agent needed.
 *
 *   npm run replay -- path/to/phinq-toolcalls.jsonl [path/to/phinq.yaml]
 *
 * Sessions are approximated by replaying events in timestamp order against a
 * fresh in-memory store keyed by request_model (the corpus does not record
 * API-key session identity — by design, it never sees stored keys).
 */
import { readFileSync } from "node:fs";
import { classifyToolCall, sessionEventKind, type Classification } from "./classifier.js";
import { SessionStore } from "./session.js";
import { loadPhinqRules, defaultPhinqRules } from "./phinq-config.js";
import type { ObservedToolCall } from "./toolcalls.js";

export interface ReplayReport {
  total: number;
  byDecision: Record<string, number>;
  byClass: Record<string, number>;
  holds: { function_name?: string; ts: string; classification: Classification }[];
  unknownTools: string[];
}

export function replayCorpus(lines: string[], phinqYamlPath?: string): ReplayReport {
  const phinq = phinqYamlPath
    ? loadPhinqRules(phinqYamlPath, (m) => console.error(`warn: ${m}`))
    : defaultPhinqRules();
  const sessions = new SessionStore(":memory:", phinq.windows);

  const calls: ObservedToolCall[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.event === "tool_call") calls.push(parsed);
    } catch {
      console.error(`warn: skipping unparseable corpus line: ${trimmed.slice(0, 80)}`);
    }
  }
  calls.sort((a, b) => a.ts.localeCompare(b.ts));

  const report: ReplayReport = {
    total: calls.length,
    byDecision: {},
    byClass: {},
    holds: [],
    unknownTools: [],
  };
  const unknown = new Set<string>();

  for (const call of calls) {
    const sessionKey = call.request_model ?? "unknown-session";
    const now = Date.parse(call.ts) || Date.now();
    const counts = sessions.counts(sessionKey, now);
    const c = classifyToolCall(
      { name: call.function_name, argumentsJson: call.arguments },
      counts,
      phinq.rules
    );

    report.byDecision[c.decision] = (report.byDecision[c.decision] ?? 0) + 1;
    report.byClass[c.action_class] = (report.byClass[c.action_class] ?? 0) + 1;
    if (c.decision === "HOLD") {
      report.holds.push({ function_name: call.function_name, ts: call.ts, classification: c });
    }
    if (c.unknown_tool && call.function_name) unknown.add(call.function_name);

    const kind = sessionEventKind(call.function_name);
    if (kind) sessions.record(sessionKey, kind, now);
  }

  report.unknownTools = [...unknown].sort();
  sessions.close();
  return report;
}

function main(): void {
  const [corpusPath, yamlPath] = process.argv.slice(2);
  if (!corpusPath) {
    console.error("usage: npm run replay -- <corpus.jsonl> [phinq.yaml]");
    process.exit(2);
  }
  const lines = readFileSync(corpusPath, "utf8").split("\n");
  const report = replayCorpus(lines, yamlPath);

  console.log(`\nReplayed ${report.total} tool calls from ${corpusPath}\n`);
  console.log("Decisions:", JSON.stringify(report.byDecision));
  console.log("Classes:  ", JSON.stringify(report.byClass));
  if (report.unknownTools.length > 0) {
    console.log(`\nUnrecognized tools (${report.unknownTools.length}) — consider phinq.yaml entries:`);
    for (const t of report.unknownTools) console.log(`  - ${t}`);
  }
  if (report.holds.length > 0) {
    console.log(`\nWould HOLD (${report.holds.length}):`);
    for (const h of report.holds) {
      console.log(
        `  ${h.ts}  ${h.function_name ?? "?"}  [${h.classification.action_class}]` +
          (h.classification.triggers.length ? `  triggers: ${h.classification.triggers.join(",")}` : "")
      );
      for (const r of h.classification.reasons) console.log(`      - ${r}`);
    }
  } else {
    console.log("\nZero HOLDs — corpus replays clean.");
  }
}

// Only run as a CLI, not when imported by tests.
if (process.argv[1]?.endsWith("replay.ts") || process.argv[1]?.endsWith("replay.js")) {
  main();
}
