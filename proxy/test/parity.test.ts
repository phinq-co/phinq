import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyToolCall } from "../src/classifier.js";

/**
 * Cross-engine parity contract, TypeScript side.
 *
 * Every fixture in fixtures/parity-corpus.jsonl must classify to exactly the
 * verdict in fixtures/parity-expected.json. The Python suite
 * (python/tests/test_parity.py) asserts against the SAME two files — so the
 * two engines cannot drift without one of these suites failing.
 *
 * If this test fails after an intentional classifier change:
 *   npm run parity:regen        # regenerate expected from the TS engine
 * then run the Python suite — it must pass against the regenerated file
 * before the change ships. Mirror the change in python/src/phinq/classifier.py
 * if it doesn't.
 */

const here = dirname(fileURLToPath(import.meta.url));
const corpus = readFileSync(join(here, "fixtures", "parity-corpus.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const expected = JSON.parse(
  readFileSync(join(here, "fixtures", "parity-expected.json"), "utf8")
);

test("every parity fixture has an expected verdict (and vice versa)", () => {
  const ids = corpus.map((c: { id: string }) => c.id);
  assert.deepEqual(new Set(ids).size, ids.length, "fixture ids must be unique");
  assert.deepEqual(ids.sort(), Object.keys(expected).sort());
});

test("TS classifier matches the parity contract on all fixtures", () => {
  for (const c of corpus) {
    const r = classifyToolCall(
      { name: c.name, argumentsJson: c.arguments_json ?? undefined },
      {
        sends: c.session.sends,
        deletes: c.session.deletes,
        recentError: c.session.recent_error,
        windowTokens: c.session.window_tokens,
      }
    );
    assert.deepEqual(
      {
        decision: r.decision,
        action_class: r.action_class,
        triggers: [...r.triggers].sort(),
        unknown_tool: r.unknown_tool,
      },
      expected[c.id],
      `fixture "${c.id}" diverged from the parity contract`
    );
  }
});
