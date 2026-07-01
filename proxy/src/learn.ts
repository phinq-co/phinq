/**
 * Precedent — `phinq learn`: compile operator verdicts into policy proposals.
 *
 *   npm run learn -- [phinq-audit.jsonl] [--config phinq.yaml]
 *                    [--min-approvals 5] [--min-denials 2] [--apply]
 *
 * The audit chain is a corpus of human judgment: every hold ends in an
 * operator verdict, and `phinq assess` grades whether the intervention was
 * right. Precedent mines that corpus and proposes phinq.yaml overrides,
 * each citing its evidence — case law for agents, not a learned black box.
 *
 * Rules (deterministic, conservative by construction):
 *  - RELAX  — a tool is proposed IRREVERSIBLE_LOW (passes, still logged)
 *    only when: every one of its holds was class-based (ZERO structural
 *    triggers — trigger categories are never relaxable), every terminal
 *    verdict was a human APPROVAL (denial blocks; timeouts don't count),
 *    it has at least --min-approvals approvals, and no hold of this tool
 *    carries a true_positive assessment (a justified hold is precedent FOR
 *    holding).
 *  - TIGHTEN — a tool is proposed IRREVERSIBLE_HIGH when denials reach
 *    --min-denials and outnumber approvals, or any of its holds is graded
 *    true_positive (the operator confirmed the hold prevented damage).
 *
 * `--apply` writes the overrides into phinq.yaml AND appends a
 * `policy_change` entry to the audit chain — policy evolution itself is
 * tamper-evident, so an auditor can replay why any decision was made at
 * any point in the log's history.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AuditLog } from "./audit.js";

interface RawEntry extends Record<string, unknown> {
  type?: string;
  ts?: string;
}

export interface ToolPrecedent {
  tool: string;
  holds: number;
  approvals: number;
  denials: number;
  timeouts: number;
  /** true when any hold for this tool fired a structural trigger. */
  trigger_based: boolean;
  true_positive_assessments: number;
  false_positive_assessments: number;
  deciders: string[];
  first_ts?: string;
  last_ts?: string;
}

export interface Proposal {
  tool: string;
  action: "relax" | "tighten";
  to: "IRREVERSIBLE_LOW" | "IRREVERSIBLE_HIGH";
  basis: string;
  precedent: ToolPrecedent;
}

export interface LearnOptions {
  minApprovals: number;
  minDenials: number;
  /** Existing phinq.yaml tool overrides — proposals matching these are skipped. */
  existingOverrides: Record<string, string>;
}

export const DEFAULT_LEARN: LearnOptions = {
  minApprovals: 5,
  minDenials: 2,
  existingOverrides: {},
};

/** Mine the audit entries into per-tool precedent records. */
export function minePrecedents(entries: RawEntry[]): Map<string, ToolPrecedent> {
  // hold_id → terminal verdict
  const holdVerdict = new Map<string, { status: string; decided_by?: string }>();
  // hold_id → tools it covered
  const holdTools = new Map<string, Set<string>>();
  // hold_id → assessments
  const holdAssessments = new Map<string, { tp: number; fp: number }>();

  for (const e of entries) {
    if (e.type === "hold_transition" && typeof e.hold_id === "string" && typeof e.status === "string") {
      const prev = holdVerdict.get(e.hold_id);
      if (!prev || e.status !== "PENDING") {
        holdVerdict.set(e.hold_id, {
          status: e.status,
          decided_by: typeof e.decided_by === "string" ? e.decided_by : prev?.decided_by,
        });
      }
    } else if (e.type === "assessment") {
      const ref = typeof e.action_id === "string" ? e.action_id : undefined;
      if (ref) {
        const a = holdAssessments.get(ref) ?? { tp: 0, fp: 0 };
        if (e.operator_judgment === "true_positive") a.tp++;
        else if (e.operator_judgment === "false_positive") a.fp++;
        holdAssessments.set(ref, a);
      }
    }
  }

  const precedents = new Map<string, ToolPrecedent>();
  const get = (tool: string): ToolPrecedent => {
    let p = precedents.get(tool);
    if (!p) {
      p = {
        tool, holds: 0, approvals: 0, denials: 0, timeouts: 0,
        trigger_based: false, true_positive_assessments: 0,
        false_positive_assessments: 0, deciders: [],
      };
      precedents.set(tool, p);
    }
    return p;
  };

  for (const e of entries) {
    if (e.type !== "decision" || e.decision !== "HOLD") continue;
    const tool = typeof e.function_name === "string" ? e.function_name : undefined;
    const holdId = typeof e.hold_id === "string" ? e.hold_id : undefined;
    if (!tool) continue;
    const p = get(tool);
    p.holds++;
    if (typeof e.ts === "string") {
      if (!p.first_ts) p.first_ts = e.ts;
      p.last_ts = e.ts;
    }
    if (Array.isArray(e.triggers) && e.triggers.length > 0) p.trigger_based = true;
    if (holdId) {
      holdTools.set(holdId, (holdTools.get(holdId) ?? new Set()).add(tool));
      const v = holdVerdict.get(holdId);
      if (v) {
        if (v.status === "APPROVED" && v.decided_by) {
          p.approvals++;
          if (!p.deciders.includes(v.decided_by)) p.deciders.push(v.decided_by);
        } else if (v.status === "DENIED") {
          p.denials++;
          if (v.decided_by && !p.deciders.includes(v.decided_by)) p.deciders.push(v.decided_by);
        } else if (v.status === "EXPIRED_TIMEOUT" || v.status === "EXPIRED_CLIENT") {
          p.timeouts++;
        }
      }
      const a = holdAssessments.get(holdId);
      if (a) {
        p.true_positive_assessments += a.tp;
        p.false_positive_assessments += a.fp;
      }
    }
  }

  return precedents;
}

/** Turn precedent into conservative, cited policy proposals. */
export function propose(
  precedents: Map<string, ToolPrecedent>,
  opts: LearnOptions = DEFAULT_LEARN
): Proposal[] {
  const out: Proposal[] = [];
  for (const p of precedents.values()) {
    const current = opts.existingOverrides[p.tool];

    // TIGHTEN — denials dominate, or a hold was graded true positive.
    if (
      (p.denials >= opts.minDenials && p.denials > p.approvals) ||
      p.true_positive_assessments > 0
    ) {
      if (current !== "IRREVERSIBLE_HIGH") {
        const why: string[] = [];
        if (p.denials > 0) why.push(`denied ${p.denials}/${p.approvals + p.denials} decided holds`);
        if (p.true_positive_assessments > 0)
          why.push(`${p.true_positive_assessments} hold(s) graded true positive (damage prevented)`);
        out.push({
          tool: p.tool,
          action: "tighten",
          to: "IRREVERSIBLE_HIGH",
          basis: why.join("; "),
          precedent: p,
        });
      }
      continue;
    }

    // RELAX — human approvals only, no triggers, enough precedent.
    if (
      !p.trigger_based &&
      p.denials === 0 &&
      p.true_positive_assessments === 0 &&
      p.approvals >= opts.minApprovals
    ) {
      if (current !== "IRREVERSIBLE_LOW" && current !== "REVERSIBLE" && current !== "RISK_REDUCING") {
        out.push({
          tool: p.tool,
          action: "relax",
          to: "IRREVERSIBLE_LOW",
          basis:
            `approved ${p.approvals}/${p.approvals} decided holds by ` +
            `${p.deciders.length} operator(s), zero denials, zero incidents, no structural triggers`,
          precedent: p,
        });
      }
    }
  }
  return out.sort((a, b) => a.tool.localeCompare(b.tool));
}

export function renderProposals(proposals: Proposal[], opts: LearnOptions): string {
  if (proposals.length === 0) {
    return (
      "No policy changes proposed.\n" +
      `Precedent thresholds: ${opts.minApprovals}+ unanimous human approvals to relax, ` +
      `${opts.minDenials}+ dominant denials (or a true-positive grading) to tighten.\n` +
      "Structural-trigger holds are never relaxable."
    );
  }
  const lines: string[] = [`Precedent proposes ${proposals.length} policy change(s):`, ""];
  for (const pr of proposals) {
    const arrow = pr.action === "relax" ? "→ relax to" : "→ pin at";
    lines.push(`  ${pr.tool}  ${arrow} ${pr.to}`);
    lines.push(`    precedent: ${pr.basis}`);
    if (pr.precedent.first_ts && pr.precedent.last_ts) {
      lines.push(`    period: ${pr.precedent.first_ts} → ${pr.precedent.last_ts}`);
    }
    lines.push("");
  }
  lines.push("Apply with --apply (writes phinq.yaml and records a policy_change audit entry).");
  lines.push("Structural-trigger holds (credentials, billing, escalation…) are never relaxable.");
  return lines.join("\n");
}

/** Merge proposals into phinq.yaml's tools: map, preserving everything else. */
export async function applyProposals(
  proposals: Proposal[],
  configPath: string,
  auditPath: string | null
): Promise<void> {
  let doc: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = parseYaml(await readFile(configPath, "utf8"));
      if (typeof parsed === "object" && parsed !== null) doc = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`cannot parse ${configPath} — not applying`);
    }
  }
  const tools = (doc.tools as Record<string, unknown> | undefined) ?? {};
  for (const pr of proposals) tools[pr.tool] = pr.to;
  doc.tools = tools;
  await writeFile(configPath, stringifyYaml(doc), "utf8");

  if (auditPath) {
    const audit = new AuditLog(auditPath, (m) => console.error(m));
    audit.append({
      type: "policy_change",
      ts: new Date().toISOString(),
      source: "phinq learn",
      changes: proposals.map((pr) => ({
        tool: pr.tool,
        to: pr.to,
        action: pr.action,
        basis: pr.basis,
        approvals: pr.precedent.approvals,
        denials: pr.precedent.denials,
        holds: pr.precedent.holds,
      })),
    } as never);
    await audit.flush();
  }
}

export async function runLearn(argv: string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") continue;
    if (argv[i].startsWith("--")) i++;
    else positional.push(argv[i]);
  }
  const auditPath = positional[0] ?? process.env.PHINQ_AUDIT_LOG ?? "phinq-audit.jsonl";
  const configPath = flag("config") ?? process.env.PHINQ_CONFIG ?? "phinq.yaml";
  const apply = argv.includes("--apply");

  let raw: string;
  try {
    raw = await readFile(auditPath, "utf8");
  } catch (err) {
    console.error(`cannot read ${auditPath}: ${String(err)}`);
    return 2;
  }
  const entries: RawEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t) as RawEntry);
    } catch {
      /* skip unparseable lines */
    }
  }

  // Existing overrides so we don't re-propose what's already policy.
  const existingOverrides: Record<string, string> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = parseYaml(await readFile(configPath, "utf8")) as Record<string, unknown>;
      const tools = parsed?.tools as Record<string, unknown> | undefined;
      if (tools) for (const [k, v] of Object.entries(tools)) existingOverrides[k] = String(v);
    } catch {
      /* unreadable config = no known overrides */
    }
  }

  const opts: LearnOptions = {
    minApprovals: Number(flag("min-approvals")) || DEFAULT_LEARN.minApprovals,
    minDenials: Number(flag("min-denials")) || DEFAULT_LEARN.minDenials,
    existingOverrides,
  };

  const proposals = propose(minePrecedents(entries), opts);
  console.log(renderProposals(proposals, opts));

  if (apply && proposals.length > 0) {
    await applyProposals(proposals, configPath, auditPath);
    console.log(
      `\nApplied ${proposals.length} change(s) to ${configPath}; policy_change entry appended to ${auditPath}.` +
        `\nRestart the proxy (or wait for config reload) for the new policy to take effect.`
    );
  }
  return 0;
}

// CLI entry when executed directly.
if (process.argv[1]?.endsWith("learn.ts") || process.argv[1]?.endsWith("learn.js")) {
  runLearn(process.argv.slice(2)).then((code) => process.exit(code));
}
