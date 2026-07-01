import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyToolCall, DEFAULT_THRESHOLDS } from "../src/classifier.js";
import { SessionStore } from "../src/session.js";
import { extractUsageTokens } from "../src/server.js";
import { buildReport } from "../src/report.js";

const noTokens = { sends: 0, deletes: 0, recentError: false };

test("token budget is OFF by default — huge usage never holds", () => {
  assert.equal(DEFAULT_THRESHOLDS.sessionTokenBudget, 0);
  const c = classifyToolCall(
    { name: "read_file", argumentsJson: '{"path":"x"}' },
    { ...noTokens, windowTokens: 10_000_000 }
  );
  assert.equal(c.decision, "ALLOW");
  assert.ok(!c.triggers.includes("TOKEN_BUDGET"));
});

test("over-budget session trips TOKEN_BUDGET and holds even safe calls", () => {
  const rules = {
    thresholds: { ...DEFAULT_THRESHOLDS, sessionTokenBudget: 100_000 },
    toolClassOverrides: {},
  };
  const under = classifyToolCall(
    { name: "read_file" },
    { ...noTokens, windowTokens: 99_999 },
    rules
  );
  assert.equal(under.decision, "ALLOW");

  const over = classifyToolCall(
    { name: "read_file" },
    { ...noTokens, windowTokens: 100_001 },
    rules
  );
  assert.equal(over.decision, "HOLD");
  assert.ok(over.triggers.includes("TOKEN_BUDGET"));
  assert.equal(over.action_class, "IRREVERSIBLE_HIGH");
  assert.ok(over.reasons.some((r) => r.includes("exceeds budget")));
});

test("session store accumulates tokens in the window and expires them", () => {
  const store = new SessionStore(":memory:", { windowMinutes: 60, errorWindowMinutes: 10 });
  const now = 1_000_000_000;
  store.recordTokens("k", 1200, now);
  store.recordTokens("k", 800, now + 60_000);
  assert.equal(store.counts("k", now + 120_000).windowTokens, 2000);
  // Outside the window the first batch ages out (window edge is strict).
  assert.equal(store.counts("k", now + 60.5 * 60_000).windowTokens, 800);
  // Other sessions are isolated; junk values ignored.
  store.recordTokens("other", -50, now);
  store.recordTokens("other", NaN, now);
  assert.equal(store.counts("other", now).windowTokens, 0);
  store.close();
});

test("extractUsageTokens handles all three dialect shapes", () => {
  // OpenAI chat completions
  assert.deepEqual(
    extractUsageTokens({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
    { prompt: 100, completion: 20, total: 120 }
  );
  // Responses / Anthropic
  assert.deepEqual(
    extractUsageTokens({ usage: { input_tokens: 50, output_tokens: 5 } }),
    { prompt: 50, completion: 5, total: 55 }
  );
  // Absent or empty usage
  assert.equal(extractUsageTokens({ choices: [] }), null);
  assert.equal(extractUsageTokens({ usage: {} }), null);
  assert.equal(extractUsageTokens(null), null);
});

test("report aggregates usage entries and per-model totals", () => {
  const entries = [
    { type: "usage", ts: "t1", model: "gpt-4o", tokens_prompt: 100, tokens_completion: 20, tokens_total: 120 },
    { type: "usage", ts: "t2", model: "gpt-4o", tokens_prompt: 200, tokens_completion: 30, tokens_total: 230 },
    { type: "usage", ts: "t3", model: "claude-sonnet", tokens_prompt: 10, tokens_completion: 5, tokens_total: 15 },
    { type: "decision", ts: "t4", decision: "HOLD", enforced: true, triggers: ["TOKEN_BUDGET"] },
  ];
  const r = buildReport("x.jsonl", entries as never, { verified: true });
  assert.equal(r.usage.responses, 3);
  assert.equal(r.usage.tokens_total, 365);
  assert.equal(r.usage.tokens_prompt, 310);
  assert.equal(r.usage.by_model["gpt-4o"], 350);
  assert.equal(r.decisions.by_trigger.TOKEN_BUDGET, 1);
});
