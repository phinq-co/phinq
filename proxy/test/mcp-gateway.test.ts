import { test } from "node:test";
import assert from "node:assert/strict";
import { McpGateway } from "../src/mcp-gateway.js";
import { HoldStore } from "../src/holds.js";

const nullLog = { info: () => {}, warn: () => {}, error: () => {} };

function collect() {
  const lines: string[] = [];
  return { lines, push: (l: string) => lines.push(l) };
}

function toolCall(id: number, name: string, args: object = {}): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

test("non-tools/call traffic relays untouched in both directions", async () => {
  const g = new McpGateway({ enforce: false, holdTimeoutMs: 1000, log: () => {} });
  const server = collect();
  const client = collect();

  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await g.handleClientLine(init, server.push, client.push);
  assert.deepEqual(server.lines, [init]);
  assert.equal(client.lines.length, 0);

  const listResult = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  g.handleServerLine(listResult, client.push);
  assert.deepEqual(client.lines, [listResult]);
});

test("ALLOW calls forward to the wrapped server", async () => {
  const g = new McpGateway({ enforce: true, holdTimeoutMs: 1000, log: () => {} });
  const server = collect();
  const client = collect();
  await g.handleClientLine(toolCall(3, "read_file", { path: "x.md" }), server.push, client.push);
  assert.equal(server.lines.length, 1);
  assert.equal(client.lines.length, 0);
});

test("shadow mode passes HOLD calls through but logs them", async () => {
  const logged: string[] = [];
  const g = new McpGateway({ enforce: false, holdTimeoutMs: 1000, log: (m) => logged.push(m) });
  const server = collect();
  const client = collect();
  await g.handleClientLine(toolCall(4, "delete_file", { path: "x" }), server.push, client.push);
  assert.equal(server.lines.length, 1);
  assert.equal(client.lines.length, 0);
  assert.ok(logged.some((m) => m.includes("shadow HOLD")));
});

test("enforced HOLD → denial returns an isError tool result, call never forwarded", async () => {
  const holds = new HoldStore(":memory:", nullLog);
  const g = new McpGateway({ enforce: true, holds, holdTimeoutMs: 60_000, log: () => {} });
  const server = collect();
  const client = collect();

  const pending = g.handleClientLine(toolCall(5, "delete_file", { path: "/data" }), server.push, client.push);
  await new Promise((r) => setTimeout(r, 20)); // let the hold register
  const holdId = holds.listPending()[0]?.id;
  assert.ok(holdId, "hold created");
  holds.decide(holdId, "deny", "cli:test");
  await pending;

  assert.equal(server.lines.length, 0, "denied call must not reach the server");
  assert.equal(client.lines.length, 1);
  const reply = JSON.parse(client.lines[0]);
  assert.equal(reply.id, 5);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /denied by the operator/);
  assert.match(reply.result.content[0].text, /NOT executed/);
  holds.close();
});

test("enforced HOLD → approval forwards the original line byte-identically", async () => {
  const holds = new HoldStore(":memory:", nullLog);
  const g = new McpGateway({ enforce: true, holds, holdTimeoutMs: 60_000, log: () => {} });
  const server = collect();
  const client = collect();

  const line = toolCall(6, "delete_file", { path: "/data/old.md" });
  const pending = g.handleClientLine(line, server.push, client.push);
  await new Promise((r) => setTimeout(r, 20));
  const holdId = holds.listPending()[0]?.id;
  holds.decide(holdId!, "approve", "cli:test");
  await pending;

  assert.deepEqual(server.lines, [line]);
  assert.equal(client.lines.length, 0);
  holds.close();
});

test("timeout auto-denies", async () => {
  const holds = new HoldStore(":memory:", nullLog);
  const g = new McpGateway({ enforce: true, holds, holdTimeoutMs: 30, log: () => {} });
  const server = collect();
  const client = collect();
  // The hold-expiry timer is unref()'d (fine under the proxy's live HTTP
  // server); keep the loop alive here with a ref'd timer.
  const keepAlive = setTimeout(() => {}, 5_000);
  await g.handleClientLine(toolCall(7, "drop_table", { table: "users" }), server.push, client.push);
  clearTimeout(keepAlive);
  assert.equal(server.lines.length, 0);
  const reply = JSON.parse(client.lines[0]);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /approval window/);
  holds.close();
});

test("audit entries are written for decisions and holds", async () => {
  const entries: Record<string, unknown>[] = [];
  const audit = { append: (e: Record<string, unknown>) => entries.push(e) };
  const g = new McpGateway({
    enforce: false,
    audit: audit as never,
    holdTimeoutMs: 1000,
    log: () => {},
  });
  const server = collect();
  const client = collect();
  await g.handleClientLine(toolCall(8, "read_file", {}), server.push, client.push);
  await g.handleClientLine(toolCall(9, "delete_file", { path: "x" }), server.push, client.push);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].decision, "ALLOW");
  assert.equal(entries[1].decision, "HOLD");
  assert.equal(entries[1].enforced, false);
});

test("tool error results arm AFTER_ERROR_BULK for subsequent volume", async () => {
  const entries: Record<string, unknown>[] = [];
  const g = new McpGateway({
    enforce: false,
    holdTimeoutMs: 1000,
    log: () => {},
    audit: { append: (e: Record<string, unknown>) => entries.push(e) } as never,
  });
  const server = collect();
  const client = collect();

  // A tool call goes out; its result comes back as an error.
  await g.handleClientLine(toolCall(10, "send_email", { to: "a@x.co" }), server.push, client.push);
  g.handleServerLine(
    JSON.stringify({ jsonrpc: "2.0", id: 10, result: { isError: true, content: [] } }),
    client.push
  );

  // Push sends past the volume threshold within the error window.
  for (let i = 0; i < 3; i++) {
    await g.handleClientLine(toolCall(11 + i, "send_email", { to: "a@x.co" }), server.push, client.push);
  }

  const last = entries.at(-1)!;
  assert.equal(last.decision, "HOLD");
  const triggers = last.triggers as string[];
  assert.ok(triggers.includes("EXTERNAL_COMM_VOLUME"), "volume trigger fired");
  assert.ok(triggers.includes("AFTER_ERROR_BULK"), "after-error trigger fired");
});
