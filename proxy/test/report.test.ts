import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, renderMarkdown, reportHash } from "../src/report.js";

const chainOK = { verified: true };

test("empty log produces zeroed report", () => {
  const r = buildReport("x.jsonl", [], chainOK);
  assert.equal(r.decisions.total, 0);
  assert.equal(r.holds.total, 0);
  assert.equal(r.assessments.false_hold_rate, null);
  assert.equal(r.chain.verified, true);
});

test("aggregates decisions, holds, and assessments", () => {
  const entries = [
    { type: "genesis", log_id: "log-1", created_at: "2026-01-01T00:00:00Z" },
    { type: "decision", ts: "2026-01-01T10:00:00Z", function_name: "read_file", action_class: "REVERSIBLE", decision: "ALLOW", enforced: true },
    { type: "decision", ts: "2026-01-01T10:01:00Z", function_name: "delete_file", action_class: "IRREVERSIBLE_MEDIUM", triggers: ["BULK_DELETE"], decision: "HOLD", enforced: true, hold_id: "h1" },
    { type: "decision", ts: "2026-01-01T10:02:00Z", function_name: "send_email", action_class: "IRREVERSIBLE_LOW", decision: "HOLD", enforced: false, hold_id: "h2" },
    { type: "hold_transition", ts: "2026-01-01T10:01:01Z", hold_id: "h1", status: "PENDING" },
    { type: "hold_transition", ts: "2026-01-01T10:02:30Z", hold_id: "h1", status: "APPROVED", decided_by: "telegram:op" },
    { type: "hold_transition", ts: "2026-01-01T10:03:00Z", hold_id: "h2", status: "EXPIRED_TIMEOUT" },
    { type: "assessment", ts: "2026-01-01T11:00:00Z", operator_judgment: "true_positive", estimated_damage_gbp: 500, damage_category: "data_loss" },
    { type: "assessment", ts: "2026-01-01T11:01:00Z", operator_judgment: "false_positive" },
    { entry_hash: "f".repeat(64), type: "decision", ts: "2026-01-01T12:00:00Z", decision: "ALLOW", enforced: true },
  ];
  const r = buildReport("x.jsonl", entries as never, chainOK);

  assert.equal(r.source.log_id, "log-1");
  assert.equal(r.source.final_entry_hash, "f".repeat(64));
  assert.equal(r.period.from, "2026-01-01T10:00:00Z");
  assert.equal(r.period.to, "2026-01-01T12:00:00Z");

  assert.equal(r.decisions.total, 4);
  assert.equal(r.decisions.allow, 2);
  assert.equal(r.decisions.hold, 2);
  assert.equal(r.decisions.enforced, 3);
  assert.equal(r.decisions.shadow, 1);
  assert.equal(r.decisions.by_trigger.BULK_DELETE, 1);
  assert.equal(r.decisions.by_action_class.IRREVERSIBLE_MEDIUM, 1);
  assert.equal(r.decisions.by_function.delete_file, 1);

  assert.equal(r.holds.total, 2);
  assert.equal(r.holds.approved, 1);
  assert.equal(r.holds.expired_timeout, 1);
  assert.equal(r.holds.human_decided, 1);

  assert.equal(r.assessments.total, 2);
  assert.equal(r.assessments.true_positive, 1);
  assert.equal(r.assessments.false_positive, 1);
  assert.equal(r.assessments.false_hold_rate, 0.5);
  assert.equal(r.assessments.estimated_damage_prevented_gbp, 500);
  assert.equal(r.assessments.by_damage_category.data_loss, 1);
});

test("PENDING does not override a terminal hold status regardless of order", () => {
  const entries = [
    { type: "hold_transition", ts: "t", hold_id: "h1", status: "DENIED", decided_by: "cli" },
    { type: "hold_transition", ts: "t", hold_id: "h1", status: "PENDING" },
  ];
  const r = buildReport("x.jsonl", entries as never, chainOK);
  assert.equal(r.holds.denied, 1);
  assert.equal(r.holds.pending, 0);
});

test("report hash is stable and sensitive", () => {
  const r1 = buildReport("x.jsonl", [], chainOK);
  const r2 = { ...r1 };
  const h1 = reportHash(r1);
  assert.equal(h1, reportHash(r2 as never));
  const r3 = { ...r1, decisions: { ...r1.decisions, total: 99 } };
  assert.notEqual(h1, reportHash(r3 as never));
});

test("markdown renders chain break and false-hold rate", () => {
  const r = buildReport("x.jsonl", [
    { type: "assessment", ts: "t", operator_judgment: "false_positive" },
  ] as never, { verified: false, first_break: { index: 3, reason: "hash mismatch" } });
  const md = renderMarkdown(r, "abc123");
  assert.match(md, /BROKEN/);
  assert.match(md, /hash mismatch/);
  assert.match(md, /False-hold rate/);
  assert.match(md, /abc123/);
});
