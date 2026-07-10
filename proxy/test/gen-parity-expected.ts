/**
 * Regenerate test/fixtures/parity-expected.json from the CURRENT TypeScript
 * classifier:
 *
 *   npm run parity:regen
 *
 * The expected file is the cross-engine contract: both the TS test
 * (test/parity.test.ts) and the Python test (python/tests/test_parity.py)
 * assert against it. Regenerating it is a deliberate, review-visible act —
 * a diff in this file in a PR means "the classifier's verdicts changed",
 * and the Python engine must be updated in the same PR to match.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyToolCall } from "../src/classifier.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, "fixtures", "parity-corpus.jsonl");
const expectedPath = join(here, "fixtures", "parity-expected.json");

interface FixtureCase {
  id: string;
  name: string;
  arguments_json: string | null;
  session: { sends: number; deletes: number; recent_error: boolean; window_tokens: number };
}

const cases: FixtureCase[] = readFileSync(corpusPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const expected: Record<
  string,
  { decision: string; action_class: string; triggers: string[]; unknown_tool: boolean }
> = {};

for (const c of cases) {
  const r = classifyToolCall(
    { name: c.name, argumentsJson: c.arguments_json ?? undefined },
    {
      sends: c.session.sends,
      deletes: c.session.deletes,
      recentError: c.session.recent_error,
      windowTokens: c.session.window_tokens,
    }
  );
  expected[c.id] = {
    decision: r.decision,
    action_class: r.action_class,
    triggers: [...r.triggers].sort(),
    unknown_tool: r.unknown_tool,
  };
}

writeFileSync(expectedPath, JSON.stringify(expected, null, 2) + "\n");
console.log(`wrote ${Object.keys(expected).length} expected verdicts → ${expectedPath}`);
