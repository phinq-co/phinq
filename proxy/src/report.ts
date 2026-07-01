/**
 * `npm run report` — generate a verifiable human-oversight report from the
 * hash-chained audit log.
 *
 *   npm run report -- [phinq-audit.jsonl] [--json out.json] [--md out.md]
 *
 * Purpose: turn the audit chain into *evidence*. The report aggregates every
 * governed decision, hold outcome, and operator assessment into a summary an
 * operator can hand to a reviewer (or attach to an EU AI Act Article 14
 * human-oversight file): what the agent tried to do, what was held, who
 * decided, how often the classifier was wrong, and whether the underlying
 * log verifies.
 *
 * The report itself is tamper-evident: `report_hash` is the SHA-256 of the
 * JCS-canonicalized report body, and the body embeds the audit chain's
 * final entry_hash — so the report pins the exact log state it summarizes.
 *
 * Exit codes: 0 = report written, chain intact; 1 = chain broken (report
 * still written, flagged); 2 = usage/IO error.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { jcs, verifyFile } from "./audit.js";

interface RawEntry extends Record<string, unknown> {
  type?: string;
  ts?: string;
  entry_hash?: string;
}

export interface OversightReport {
  phinq_report_version: 1;
  generated_at: string;
  source: { path: string; log_id?: string; entries: number; final_entry_hash?: string };
  chain: { verified: boolean; first_break?: { index: number; reason: string } };
  period: { from?: string; to?: string };
  decisions: {
    total: number;
    allow: number;
    hold: number;
    enforced: number;
    shadow: number;
    by_action_class: Record<string, number>;
    by_trigger: Record<string, number>;
    by_function: Record<string, number>;
  };
  holds: {
    total: number;
    approved: number;
    denied: number;
    expired_timeout: number;
    expired_client: number;
    pending: number;
    human_decided: number;
  };
  usage: {
    responses: number;
    tokens_prompt: number;
    tokens_completion: number;
    tokens_total: number;
    by_model: Record<string, number>;
  };
  assessments: {
    total: number;
    true_positive: number;
    false_positive: number;
    unclear: number;
    /** false_positive / (true_positive + false_positive) — the calibration metric. */
    false_hold_rate: number | null;
    estimated_damage_prevented_gbp: number;
    by_damage_category: Record<string, number>;
  };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function buildReport(
  path: string,
  entries: RawEntry[],
  chain: { verified: boolean; first_break?: { index: number; reason: string } }
): OversightReport {
  const report: OversightReport = {
    phinq_report_version: 1,
    generated_at: new Date().toISOString(),
    source: { path, entries: entries.length },
    chain,
    period: {},
    decisions: {
      total: 0, allow: 0, hold: 0, enforced: 0, shadow: 0,
      by_action_class: {}, by_trigger: {}, by_function: {},
    },
    holds: {
      total: 0, approved: 0, denied: 0, expired_timeout: 0,
      expired_client: 0, pending: 0, human_decided: 0,
    },
    usage: {
      responses: 0, tokens_prompt: 0, tokens_completion: 0, tokens_total: 0,
      by_model: {},
    },
    assessments: {
      total: 0, true_positive: 0, false_positive: 0, unclear: 0,
      false_hold_rate: null, estimated_damage_prevented_gbp: 0,
      by_damage_category: {},
    },
  };

  // Terminal status per hold_id (later transitions override PENDING).
  const holdStatus = new Map<string, { status: string; decided_by?: string }>();

  for (const e of entries) {
    if (typeof e.ts === "string") {
      if (!report.period.from) report.period.from = e.ts;
      report.period.to = e.ts;
    }
    switch (e.type) {
      case "genesis":
        if (typeof e.log_id === "string") report.source.log_id = e.log_id;
        break;
      case "decision": {
        const d = report.decisions;
        d.total++;
        if (e.decision === "HOLD") d.hold++; else d.allow++;
        if (e.enforced === true) d.enforced++; else d.shadow++;
        if (typeof e.action_class === "string") bump(d.by_action_class, e.action_class);
        if (typeof e.function_name === "string") bump(d.by_function, e.function_name);
        if (Array.isArray(e.triggers)) for (const t of e.triggers) if (typeof t === "string") bump(d.by_trigger, t);
        break;
      }
      case "hold_transition": {
        if (typeof e.hold_id === "string" && typeof e.status === "string") {
          const prev = holdStatus.get(e.hold_id);
          if (!prev || e.status !== "PENDING") {
            holdStatus.set(e.hold_id, {
              status: e.status,
              decided_by: typeof e.decided_by === "string" ? e.decided_by : prev?.decided_by,
            });
          }
        }
        break;
      }
      case "usage": {
        const u = report.usage;
        u.responses++;
        if (typeof e.tokens_prompt === "number") u.tokens_prompt += e.tokens_prompt;
        if (typeof e.tokens_completion === "number") u.tokens_completion += e.tokens_completion;
        if (typeof e.tokens_total === "number") {
          u.tokens_total += e.tokens_total;
          if (typeof e.model === "string") {
            u.by_model[e.model] = (u.by_model[e.model] ?? 0) + e.tokens_total;
          }
        }
        break;
      }
      case "assessment": {
        const a = report.assessments;
        a.total++;
        const j = e.operator_judgment;
        if (j === "true_positive") a.true_positive++;
        else if (j === "false_positive") a.false_positive++;
        else a.unclear++;
        if (typeof e.estimated_damage_gbp === "number" && j === "true_positive") {
          a.estimated_damage_prevented_gbp += e.estimated_damage_gbp;
        }
        if (typeof e.damage_category === "string") bump(a.by_damage_category, e.damage_category);
        break;
      }
    }
    if (typeof e.entry_hash === "string") report.source.final_entry_hash = e.entry_hash;
  }

  const h = report.holds;
  h.total = holdStatus.size;
  for (const { status, decided_by } of holdStatus.values()) {
    if (status === "APPROVED") h.approved++;
    else if (status === "DENIED") h.denied++;
    else if (status === "EXPIRED_TIMEOUT") h.expired_timeout++;
    else if (status === "EXPIRED_CLIENT") h.expired_client++;
    else if (status === "PENDING") h.pending++;
    if (decided_by && (status === "APPROVED" || status === "DENIED")) h.human_decided++;
  }

  const a = report.assessments;
  const graded = a.true_positive + a.false_positive;
  a.false_hold_rate = graded > 0 ? a.false_positive / graded : null;

  return report;
}

/** SHA-256 over the JCS-canonical report body — pin the report itself. */
export function reportHash(report: OversightReport): string {
  return createHash("sha256").update(jcs(report as unknown as Record<string, unknown>)).digest("hex");
}

function pct(n: number, of: number): string {
  return of > 0 ? `${((n / of) * 100).toFixed(1)}%` : "–";
}

function topN(map: Record<string, number>, n: number): [string, number][] {
  return Object.entries(map).sort((x, y) => y[1] - x[1]).slice(0, n);
}

export function renderMarkdown(r: OversightReport, hash: string): string {
  const d = r.decisions, h = r.holds, a = r.assessments;
  const lines: string[] = [
    `# Phinq human-oversight report`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Generated | ${r.generated_at} |`,
    `| Audit log | \`${r.source.path}\` (${r.source.entries} entries) |`,
    `| Log ID | \`${r.source.log_id ?? "unknown"}\` |`,
    `| Period | ${r.period.from ?? "–"} → ${r.period.to ?? "–"} |`,
    `| Chain verification | ${r.chain.verified ? "✅ intact" : `❌ **BROKEN** at entry ${r.chain.first_break?.index}: ${r.chain.first_break?.reason}`} |`,
    `| Final entry hash | \`${r.source.final_entry_hash ?? "–"}\` |`,
    `| Report hash | \`${hash}\` |`,
    ``,
    `## Decisions`,
    ``,
    `${d.total} tool calls governed — **${d.allow} allowed** (${pct(d.allow, d.total)}), **${d.hold} held** (${pct(d.hold, d.total)}). ${d.enforced} enforced, ${d.shadow} shadow-mode.`,
    ``,
  ];
  const classes = topN(d.by_action_class, 10);
  if (classes.length) {
    lines.push(`| Action class | Count |`, `|---|---|`);
    for (const [k, v] of classes) lines.push(`| ${k} | ${v} |`);
    lines.push(``);
  }
  const trig = topN(d.by_trigger, 10);
  if (trig.length) {
    lines.push(`| Structural trigger | Fired |`, `|---|---|`);
    for (const [k, v] of trig) lines.push(`| ${k} | ${v} |`);
    lines.push(``);
  }
  if (r.usage.responses > 0) {
    lines.push(
      `## Token usage — the fuel gauge`,
      ``,
      `${r.usage.tokens_total.toLocaleString("en-GB")} tokens across ${r.usage.responses} responses (${r.usage.tokens_prompt.toLocaleString("en-GB")} prompt / ${r.usage.tokens_completion.toLocaleString("en-GB")} completion).`,
      ``
    );
    const models = topN(r.usage.by_model, 10);
    if (models.length) {
      lines.push(`| Model | Tokens |`, `|---|---|`);
      for (const [k, v] of models) lines.push(`| ${k} | ${v.toLocaleString("en-GB")} |`);
      lines.push(``);
    }
  }
  lines.push(
    `## Holds — human-in-the-loop outcomes`,
    ``,
    `${h.total} holds: **${h.approved} approved**, **${h.denied} denied**, ${h.expired_timeout} auto-denied on timeout, ${h.expired_client} abandoned by client, ${h.pending} pending. ${h.human_decided} decided by a human operator.`,
    ``,
    `## Operator assessments — calibration`,
    ``
  );
  if (a.total === 0) {
    lines.push(`No graded interventions yet. Grade holds with \`phinq assess\` to compute the false-hold rate.`);
  } else {
    lines.push(
      `${a.total} graded: ${a.true_positive} true positives, ${a.false_positive} false alarms, ${a.unclear} unclear.`,
      ``,
      `**False-hold rate: ${a.false_hold_rate === null ? "–" : pct(a.false_positive, a.true_positive + a.false_positive)}**` +
        (a.estimated_damage_prevented_gbp > 0
          ? ` · Estimated damage prevented: **£${a.estimated_damage_prevented_gbp.toLocaleString("en-GB")}**`
          : "")
    );
    const cats = topN(a.by_damage_category, 10);
    if (cats.length) {
      lines.push(``, `| Damage category | Count |`, `|---|---|`);
      for (const [k, v] of cats) lines.push(`| ${k} | ${v} |`);
    }
  }
  lines.push(
    ``,
    `---`,
    ``,
    `*Verify this report: recompute SHA-256 over the JCS-canonical JSON body and compare to the report hash. Verify the source log: \`npm run audit:verify -- ${r.source.path}\`. The report pins the log's final entry hash, so any post-hoc edit to the log invalidates both.*`,
    ``
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) i++; // skip the flag's value too
    else positional.push(args[i]);
  }
  const path = positional[0] ?? "phinq-audit.jsonl";
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    console.error(`cannot read ${path}: ${String(err)}`);
    process.exit(2);
  }
  const entries: RawEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t) as RawEntry);
    } catch {
      /* unparseable line — verifyFile reports it; skip for aggregation */
    }
  }

  const v = await verifyFile(path);
  const report = buildReport(path, entries, {
    verified: v.ok,
    ...(v.firstBreak ? { first_break: { index: v.firstBreak.index, reason: v.firstBreak.reason } } : {}),
  });
  const hash = reportHash(report);
  const md = renderMarkdown(report, hash);

  const jsonOut = flag("json");
  const mdOut = flag("md");
  if (jsonOut) await writeFile(jsonOut, JSON.stringify({ ...report, report_hash: hash }, null, 2) + "\n", "utf8");
  if (mdOut) await writeFile(mdOut, md, "utf8");
  if (!jsonOut && !mdOut) console.log(md);
  else console.log(`report written${jsonOut ? ` → ${jsonOut}` : ""}${mdOut ? ` → ${mdOut}` : ""} (report_hash ${hash.slice(0, 16)}…)`);

  process.exit(v.ok ? 0 : 1);
}

// Only run as a CLI when executed directly (not when imported by tests).
if (process.argv[1]?.endsWith("report.ts") || process.argv[1]?.endsWith("report.js")) {
  void main();
}
