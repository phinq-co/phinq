import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { minePrecedents, propose, applyProposals, DEFAULT_LEARN } from "../src/learn.js";
import { verifyFile, AuditLog } from "../src/audit.js";

function decision(tool: string, holdId: string, triggers: string[] = [], ts = "2026-01-01T00:00:00Z") {
  return { type: "decision", ts, function_name: tool, decision: "HOLD", enforced: true, hold_id: holdId, triggers };
}
function verdict(holdId: string, status: string, decidedBy?: string) {
  return { type: "hold_transition", ts: "t", hold_id: holdId, status, decided_by: decidedBy };
}

test("unanimous human approvals with no triggers propose a relax, with citations", () => {
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    entries.push(decision("send_newsletter", `h${i}`));
    entries.push(verdict(`h${i}`, "PENDING"));
    entries.push(verdict(`h${i}`, "APPROVED", "telegram:op"));
  }
  const proposals = propose(minePrecedents(entries as never), DEFAULT_LEARN);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].tool, "send_newsletter");
  assert.equal(proposals[0].action, "relax");
  assert.equal(proposals[0].to, "IRREVERSIBLE_LOW");
  assert.match(proposals[0].basis, /approved 5\/5/);
});

test("a single denial blocks relaxation", () => {
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < 6; i++) {
    entries.push(decision("send_newsletter", `h${i}`));
    entries.push(verdict(`h${i}`, i === 3 ? "DENIED" : "APPROVED", "cli:op"));
  }
  const proposals = propose(minePrecedents(entries as never), DEFAULT_LEARN);
  assert.equal(proposals.filter((p) => p.action === "relax").length, 0);
});

test("trigger-based holds are NEVER relaxable regardless of approvals", () => {
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    entries.push(decision("read_env_file", `h${i}`, ["CREDENTIAL_ACCESS"]));
    entries.push(verdict(`h${i}`, "APPROVED", "telegram:op"));
  }
  const proposals = propose(minePrecedents(entries as never), DEFAULT_LEARN);
  assert.equal(proposals.length, 0);
});

test("timeouts neither count as approvals nor block", () => {
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    entries.push(decision("send_newsletter", `h${i}`));
    entries.push(verdict(`h${i}`, "APPROVED", "cli:op"));
  }
  entries.push(decision("send_newsletter", "hT"));
  entries.push(verdict("hT", "EXPIRED_TIMEOUT"));
  const proposals = propose(minePrecedents(entries as never), DEFAULT_LEARN);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].action, "relax");
});

test("dominant denials propose a tighten", () => {
  const entries: Record<string, unknown>[] = [
    decision("drop_table", "h1"), verdict("h1", "DENIED", "cli:op"),
    decision("drop_table", "h2"), verdict("h2", "DENIED", "cli:op"),
    decision("drop_table", "h3"), verdict("h3", "APPROVED", "cli:op"),
  ];
  const proposals = propose(minePrecedents(entries as never), DEFAULT_LEARN);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].action, "tighten");
  assert.equal(proposals[0].to, "IRREVERSIBLE_HIGH");
  assert.match(proposals[0].basis, /denied 2\/3/);
});

test("a true_positive assessment forces a tighten and blocks relax", () => {
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < 8; i++) {
    entries.push(decision("send_campaign", `h${i}`));
    entries.push(verdict(`h${i}`, "APPROVED", "cli:op"));
  }
  entries.push(decision("send_campaign", "hBad"));
  entries.push(verdict("hBad", "DENIED", "cli:op"));
  entries.push({ type: "assessment", ts: "t", action_id: "hBad", operator_judgment: "true_positive" });
  const proposals = propose(minePrecedents(entries as never), DEFAULT_LEARN);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].action, "tighten");
  assert.match(proposals[0].basis, /true positive/);
});

test("existing overrides are not re-proposed", () => {
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    entries.push(decision("send_newsletter", `h${i}`));
    entries.push(verdict(`h${i}`, "APPROVED", "cli:op"));
  }
  const proposals = propose(minePrecedents(entries as never), {
    ...DEFAULT_LEARN,
    existingOverrides: { send_newsletter: "IRREVERSIBLE_LOW" },
  });
  assert.equal(proposals.length, 0);
});

test("apply writes phinq.yaml and appends a verifiable policy_change entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phinq-learn-"));
  const configPath = join(dir, "phinq.yaml");
  const auditPath = join(dir, "audit.jsonl");
  await writeFile(configPath, "thresholds:\n  bulk_delete_count: 5\n", "utf8");
  // seed a real chain so the policy_change extends it
  const seed = new AuditLog(auditPath, () => {});
  seed.append({ type: "decision", ts: "t", decision: "ALLOW", enforced: false } as never);
  await seed.flush();

  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    entries.push(decision("send_newsletter", `h${i}`));
    entries.push(verdict(`h${i}`, "APPROVED", "cli:op"));
  }
  const proposals = propose(minePrecedents(entries as never), DEFAULT_LEARN);
  await applyProposals(proposals, configPath, auditPath);

  const yaml = parseYaml(await readFile(configPath, "utf8")) as Record<string, unknown>;
  assert.equal((yaml.tools as Record<string, unknown>).send_newsletter, "IRREVERSIBLE_LOW");
  assert.equal((yaml.thresholds as Record<string, unknown>).bulk_delete_count, 5); // preserved

  const v = await verifyFile(auditPath);
  assert.equal(v.ok, true, "chain must remain intact after policy_change");
  const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
  const last = JSON.parse(lines.at(-1)!);
  assert.equal(last.type, "policy_change");
  assert.equal(last.changes[0].tool, "send_newsletter");
  assert.match(last.changes[0].basis, /approved 5\/5/);

  await rm(dir, { recursive: true, force: true });
});
