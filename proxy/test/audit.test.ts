import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcs, entryHash, AuditLog, verifyChain, verifyFile } from "../src/audit.js";

const noop = () => {};

// ---------------------------------------------------------------------------
// JCS — RFC 8785 canonicalization
// ---------------------------------------------------------------------------

test("jcs sorts keys, strips whitespace, and is stable for nested structures", () => {
  assert.equal(jcs({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(jcs({ z: { y: [2, 1], x: null }, a: true }), '{"a":true,"z":{"x":null,"y":[2,1]}}');
  // undefined values are dropped from objects (like JSON.stringify) and
  // nulled in arrays — serializer-drift-proof either way.
  assert.equal(jcs({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(jcs([undefined, 1]), "[null,1]");
});

test("jcs number serialization matches the RFC 8785 test vector", () => {
  // From RFC 8785 §3.2.2.3.
  assert.equal(
    jcs({ numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27] }),
    '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}'
  );
});

test("jcs sorts keys by UTF-16 code units, not locale", () => {
  // From RFC 8785 §3.2.3 (sorting): "€" (€) sorts before "𐅉"
  // even though the latter has a lower code *point*, because sorting is on
  // UTF-16 code units.
  const canonical = jcs({ "\u{10149}": "supplementary", "€": "euro" });
  assert.ok(canonical.indexOf("euro") < canonical.indexOf("supplementary"));
});

test("entryHash is deterministic and chains on prev_hash", () => {
  const e = { type: "decision", ts: "2026-06-10T00:00:00Z" };
  const h1 = entryHash("0".repeat(64), e);
  assert.equal(h1, entryHash("0".repeat(64), { ts: "2026-06-10T00:00:00Z", type: "decision" }));
  assert.notEqual(h1, entryHash("1".repeat(64), e), "different prev_hash must change the hash");
});

// ---------------------------------------------------------------------------
// Writer + verifier
// ---------------------------------------------------------------------------

async function freshLog(name: string): Promise<string> {
  const path = join(tmpdir(), `phinq-audit-test-${process.pid}-${name}.jsonl`);
  await rm(path, { force: true });
  return path;
}

test("append + verify: a clean chain verifies, genesis first", async () => {
  const path = await freshLog("clean");
  const log = new AuditLog(path, noop);
  log.append({ type: "decision", ts: "t1", function_name: "send_email", decision: "ALLOW", enforced: false });
  log.append({ type: "decision", ts: "t2", function_name: "shell_exec", decision: "HOLD", enforced: true, hold_id: "h1" });
  log.append({ type: "hold_transition", ts: "t3", hold_id: "h1", status: "DENIED", decided_by: "telegram:1" });
  await log.flush();

  const result = await verifyFile(path);
  assert.deepEqual(result, { ok: true, entries: 4 }); // genesis + 3

  const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "genesis");
  assert.ok(lines[0].log_id);
  assert.equal(lines[0].prev_hash, "0".repeat(64));
  assert.equal(lines[2].prev_hash, lines[1].entry_hash, "each entry links to the previous");
  await rm(path, { force: true });
});

test("tampering with any historical field is detected at the right index", async () => {
  const path = await freshLog("tamper");
  const log = new AuditLog(path, noop);
  log.append({ type: "decision", ts: "t1", decision: "HOLD", enforced: true });
  log.append({ type: "decision", ts: "t2", decision: "ALLOW", enforced: true });
  await log.flush();

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  // Operator quietly rewrites history: HOLD → ALLOW on entry 1.
  const doctored = [...lines];
  doctored[1] = doctored[1].replace('"decision":"HOLD"', '"decision":"ALLOW"');
  const result = verifyChain(doctored);
  assert.equal(result.ok, false);
  assert.equal(result.firstBreak!.index, 1);
  assert.match(result.firstBreak!.reason, /entry modified/);
  await rm(path, { force: true });
});

test("reordering entries is detected", async () => {
  const path = await freshLog("reorder");
  const log = new AuditLog(path, noop);
  log.append({ type: "decision", ts: "t1", enforced: false });
  log.append({ type: "decision", ts: "t2", enforced: false });
  await log.flush();

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const swapped = [lines[0], lines[2], lines[1]];
  const result = verifyChain(swapped);
  assert.equal(result.ok, false);
  assert.equal(result.firstBreak!.index, 1);
  assert.match(result.firstBreak!.reason, /prev_hash/);
  await rm(path, { force: true });
});

test("removing a middle entry is detected", async () => {
  const path = await freshLog("remove");
  const log = new AuditLog(path, noop);
  log.append({ type: "decision", ts: "t1", enforced: false });
  log.append({ type: "decision", ts: "t2", enforced: false });
  await log.flush();
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const result = verifyChain([lines[0], lines[2]]); // entry 1 deleted
  assert.equal(result.ok, false);
  assert.equal(result.firstBreak!.index, 1);
  await rm(path, { force: true });
});

test("a log without genesis fails verification", () => {
  const entry = { type: "decision", ts: "t1" };
  const hash = entryHash("0".repeat(64), entry);
  const line = JSON.stringify({ ...entry, prev_hash: "0".repeat(64), entry_hash: hash });
  const result = verifyChain([line]);
  assert.equal(result.ok, false);
  assert.match(result.firstBreak!.reason, /genesis/);
});

test("restart resumes the chain instead of writing a second genesis", async () => {
  const path = await freshLog("resume");
  const first = new AuditLog(path, noop);
  first.append({ type: "decision", ts: "t1", enforced: false });
  await first.flush();

  const second = new AuditLog(path, noop); // simulated restart
  second.append({ type: "decision", ts: "t2", enforced: false });
  await second.flush();

  const result = await verifyFile(path);
  assert.deepEqual(result, { ok: true, entries: 3 }); // ONE genesis + 2 decisions
  const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.type === "genesis").length, 1);
  await rm(path, { force: true });
});

test("verify reports unparseable garbage as a break", async () => {
  const path = await freshLog("garbage");
  const log = new AuditLog(path, noop);
  await log.flush();
  let content = await readFile(path, "utf8");
  content += "{corrupted line\n";
  await writeFile(path, content);
  const result = await verifyFile(path);
  assert.equal(result.ok, false);
  assert.match(result.firstBreak!.reason, /unparseable/);
  await rm(path, { force: true });
});
