/**
 * `phinq audit verify` — walk the hash chain and report the first break.
 *
 *   npm run audit:verify -- [phinq-audit.jsonl]
 *
 * Exit codes: 0 = chain intact, 1 = break found, 2 = usage/IO error.
 */
import { verifyFile } from "./audit.js";

async function main(): Promise<void> {
  const path = process.argv[2] ?? "phinq-audit.jsonl";
  let result;
  try {
    result = await verifyFile(path);
  } catch (err) {
    console.error(`cannot read ${path}: ${String(err)}`);
    process.exit(2);
  }
  if (result.ok) {
    console.log(`OK — ${result.entries} entries, chain intact (${path})`);
    process.exit(0);
  }
  const b = result.firstBreak!;
  console.error(`TAMPER DETECTED — first break at entry ${b.index}${b.ts ? ` (ts ${b.ts})` : ""}`);
  console.error(`reason: ${b.reason}`);
  console.error(`${result.entries} entries verified clean before the break.`);
  process.exit(1);
}

void main();
