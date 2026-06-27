import { test } from "node:test";
import assert from "node:assert/strict";
import { PhinqGovernor, MemorySessionStore } from "../src/index.js";
import { governTool } from "../src/adapters/mastra.js";

test("classify: a credential read holds with CREDENTIAL_ACCESS", () => {
  const g = new PhinqGovernor();
  const c = g.classify({ name: "run_shell", args: { command: "cat .env" } });
  assert.equal(c.decision, "HOLD");
  assert.ok(c.triggers.includes("CREDENTIAL_ACCESS"));
});

test("gate: a benign call is allowed instantly", async () => {
  const g = new PhinqGovernor();
  const r = await g.gate({ name: "get_weather", args: { city: "NYC" } });
  assert.equal(r.allowed, true);
  assert.equal(r.decision, "ALLOW");
  assert.equal(r.resolution, "allowed");
});

test("gate: HOLD + approve handler runs; deny handler blocks", async () => {
  const g = new PhinqGovernor();
  const approve = await g.gate(
    { name: "run_shell", args: { command: "rm -rf build" } },
    { onHold: () => "approve" }
  );
  assert.equal(approve.allowed, true);
  assert.equal(approve.resolution, "approved");

  const deny = await g.gate(
    { name: "run_shell", args: { command: "rm -rf build" } },
    { onHold: () => "deny" }
  );
  assert.equal(deny.allowed, false);
  assert.equal(deny.resolution, "denied");
});

test("gate: HOLD with no handler fails safe (default deny)", async () => {
  const g = new PhinqGovernor();
  const r = await g.gate({ name: "run_shell", args: { command: "sudo reboot" } });
  assert.equal(r.allowed, false);
  assert.equal(r.resolution, "denied");
});

test("gate: defaultOnHold can be set to approve", async () => {
  const g = new PhinqGovernor({ defaultOnHold: "approve" });
  const r = await g.gate({ name: "run_shell", args: { command: "sudo reboot" } });
  assert.equal(r.allowed, true);
  assert.equal(r.resolution, "approved");
});

test("gate: a slow handler auto-denies on timeout", async () => {
  const g = new PhinqGovernor();
  const r = await g.gate(
    { name: "run_shell", args: { command: "rm -rf build" } },
    { onHold: () => new Promise(() => {}), holdTimeoutMs: 40 }
  );
  assert.equal(r.allowed, false);
  assert.equal(r.resolution, "timed_out");
});

test("audit: one entry per call, never the arguments", async () => {
  const entries: any[] = [];
  const g = new PhinqGovernor({ onAudit: (e) => entries.push(e) });
  await g.gate({ name: "run_shell", args: { command: "cat .env" } }, { onHold: () => "deny" });
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.name, "run_shell");
  assert.equal(e.decision, "HOLD");
  assert.equal(e.allowed, false);
  assert.ok(e.args_bytes > 0);
  assert.ok(!("arguments" in e), "audit entry must not carry raw arguments");
});

test("MemorySessionStore: rolling counts accumulate within the window", () => {
  const s = new MemorySessionStore({ windowMinutes: 60, errorWindowMinutes: 10 });
  const now = Date.now();
  for (let i = 0; i < 4; i++) s.record("agent-1", "send", now);
  assert.equal(s.counts("agent-1", now).sends, 4);
  // outside the window: forgotten
  assert.equal(s.counts("agent-1", now + 61 * 60_000).sends, 0);
});

test("mastra adapter: denied call returns a message and never runs the tool", async () => {
  const g = new PhinqGovernor();
  let ran = false;
  const tool = {
    id: "run_shell",
    execute: async ({ context }: { context: { command: string } }) => {
      ran = true;
      return `ran: ${context.command}`;
    },
  };
  const governed = governTool(tool, g, { onHold: () => "deny" });
  const out = await governed.execute!({ context: { command: "rm -rf /" } });
  assert.equal(ran, false, "tool must not execute when denied");
  assert.match(String(out), /withheld by Phinq governance/);
});

test("mastra adapter: approved call runs the original tool", async () => {
  const g = new PhinqGovernor();
  let ran = false;
  const tool = {
    id: "run_shell",
    execute: async ({ context }: { context: { command: string } }) => {
      ran = true;
      return `ran: ${context.command}`;
    },
  };
  const governed = governTool(tool, g, { onHold: () => "approve" });
  const out = await governed.execute!({ context: { command: "rm -rf build" } });
  assert.equal(ran, true);
  assert.equal(out, "ran: rm -rf build");
});
