import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.js";
import { HoldStore, syntheticDenial, type HoldOutcome } from "../src/holds.js";
import type { TelegramNotifier } from "../src/telegram.js";
import type { ProxyConfig } from "../src/config.js";

const nullLog = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Unit: synthetic denial shape (spec decision #4)
// ---------------------------------------------------------------------------

test("syntheticDenial mirrors id/model/usage, finish_reason stop, no tool_calls", () => {
  const held = Buffer.from(
    JSON.stringify({
      id: "gen-99",
      created: 1234,
      model: "anthropic/claude-sonnet-4-6",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1" }] } }],
    })
  );
  const denial = JSON.parse(syntheticDenial(held, "denied").toString());
  assert.equal(denial.id, "gen-99");
  assert.equal(denial.model, "anthropic/claude-sonnet-4-6");
  assert.deepEqual(denial.usage, { prompt_tokens: 10, completion_tokens: 5 });
  assert.equal(denial.choices.length, 1);
  assert.equal(denial.choices[0].finish_reason, "stop");
  assert.equal(denial.choices[0].message.role, "assistant");
  assert.match(denial.choices[0].message.content, /denied by the operator/);
  assert.ok(!("tool_calls" in denial.choices[0].message), "no tool_calls key allowed");
  const timeout = JSON.parse(syntheticDenial(held, "timeout").toString());
  assert.match(timeout.choices[0].message.content, /approval window expired/);
});

// ---------------------------------------------------------------------------
// Unit: hold state machine
// ---------------------------------------------------------------------------

test("first decision wins; later decisions are no-ops", async () => {
  const store = new HoldStore(":memory:", nullLog);
  const { id, outcome } = store.createAndWait({
    responseBody: Buffer.from("{}"),
    calls: [],
    timeoutMs: 60_000,
  });
  assert.deepEqual(store.decide(id, "approve", "telegram:1"), { result: "applied", status: "APPROVED" });
  assert.deepEqual(store.decide(id, "deny", "telegram:1"), { result: "already", status: "APPROVED" });
  assert.equal(await outcome, "APPROVED");
  assert.equal(store.get(id)!.decided_by, "telegram:1");
  store.close();
});

test("timeout expires the hold; a late approval is reported late and not executed", async () => {
  const store = new HoldStore(":memory:", nullLog);
  const { id, outcome } = store.createAndWait({
    responseBody: Buffer.from("{}"),
    calls: [],
    timeoutMs: 30, // expire fast
  });
  assert.equal(await outcome, "EXPIRED_TIMEOUT");
  const late = store.decide(id, "approve", "telegram:1");
  assert.deepEqual(late, { result: "late", status: "EXPIRED_TIMEOUT" });
  store.close();
});

test("client disconnect expires the hold as EXPIRED_CLIENT", async () => {
  const store = new HoldStore(":memory:", nullLog);
  const { id, outcome } = store.createAndWait({
    responseBody: Buffer.from("{}"),
    calls: [],
    timeoutMs: 60_000,
  });
  store.clientClosed(id);
  assert.equal(await outcome, "EXPIRED_CLIENT");
  assert.deepEqual(store.decide(id, "approve", "telegram:1"), {
    result: "late",
    status: "EXPIRED_CLIENT",
  });
  store.close();
});

test("restart recovery: PENDING holds in the DB become EXPIRED_CLIENT", async () => {
  const dbPath = join(tmpdir(), `phinq-holds-test-${process.pid}.db`);
  await rm(dbPath, { force: true });
  const first = new HoldStore(dbPath, nullLog);
  const { id } = first.createAndWait({
    responseBody: Buffer.from("{}"),
    calls: [],
    timeoutMs: 60_000,
  });
  // Simulate a crash: no decision, no close() transition. Reopen the file.
  const reopened = new HoldStore(dbPath, nullLog);
  assert.equal(reopened.get(id)!.status, "EXPIRED_CLIENT");
  assert.equal(reopened.get(id)!.decided_by, "startup_recovery");
  reopened.close();
  await rm(dbPath, { force: true });
});

test("callback tags are per-decision HMACs", () => {
  const store = new HoldStore(":memory:", nullLog);
  const a = store.callbackTag("abc", "approve");
  const d = store.callbackTag("abc", "deny");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, d, "approve and deny must have different tags");
  assert.equal(a, store.callbackTag("abc", "approve"), "tags are stable per install");
  store.close();
});

// ---------------------------------------------------------------------------
// End-to-end: enforcement through the full server with mock upstream+Telegram
// ---------------------------------------------------------------------------

let upstream: http.Server;
let telegram: http.Server;
let app: ReturnType<typeof buildServer>;
let upstreamBody = "{}";
let sentMessages: Record<string, unknown>[] = [];
const auditPath = join(tmpdir(), `phinq-audit-e2e-${process.pid}.jsonl`);

const HELD_RESPONSE = JSON.stringify({
  id: "gen-h1",
  created: 999,
  model: "test-model",
  usage: { prompt_tokens: 1, completion_tokens: 2 },
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "shell_exec", arguments: '{"cmd":"cat .env"}' } },
        ],
      },
    },
  ],
});

function phinqInternals() {
  return (app as unknown as { phinq: { holds: HoldStore; notifier: TelegramNotifier } }).phinq;
}

/** Extract {data} of the Approve/Deny buttons from the last Telegram message. */
function lastButtons(): { approve: string; deny: string } {
  const last = sentMessages.at(-1)!;
  const kb = (last.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] })
    .inline_keyboard[0];
  return { approve: kb[0].callback_data, deny: kb[1].callback_data };
}

before(async () => {
  await rm(auditPath, { force: true });
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(upstreamBody);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as { port: number }).port;

  telegram = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const respond = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      };
      if (req.url!.endsWith("/sendMessage")) {
        sentMessages.push(payload);
        respond({ message_id: sentMessages.length });
      } else if (req.url!.endsWith("/getUpdates")) {
        // Slow empty long-poll so the poller doesn't spin during tests.
        setTimeout(() => respond([]), 200);
      } else {
        respond({});
      }
    });
  });
  await new Promise<void>((r) => telegram.listen(0, "127.0.0.1", r));
  const telegramPort = (telegram.address() as { port: number }).port;

  const config: ProxyConfig = {
    port: 0,
    host: "127.0.0.1",
    upstream: `http://127.0.0.1:${upstreamPort}`,
    upstreamTimeoutMs: 2000,
    toolCallLogPath: "",
    phinqConfigPath: "/nonexistent/phinq.yaml",
    sessionDbPath: ":memory:",
    holdDbPath: ":memory:",
    auditLogPath: auditPath,
    enforce: true,
    holdTimeoutSeconds: 2,
    telegramBotToken: "test-token",
    telegramChatId: "777",
    telegramApiBase: `http://127.0.0.1:${telegramPort}`,
  };
  app = buildServer(config);
  await app.ready();
});

after(async () => {
  await app.close();
  upstream.close();
  telegram.close();
});

/** Inject a governed request and the operator decision concurrently. */
async function injectWithDecision(
  decide: ((buttons: { approve: string; deny: string }) => Promise<void>) | null
) {
  upstreamBody = HELD_RESPONSE;
  const beforeCount = sentMessages.length;
  const pending = app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json", authorization: "Bearer sk-e2e" },
    payload: JSON.stringify({ model: "test-model", stream: false, messages: [] }),
  });
  // Wait until the hold notification reached (mock) Telegram.
  while (sentMessages.length === beforeCount) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (decide) await decide(lastButtons());
  return pending;
}

function callback(data: string, fromId = 777) {
  return phinqInternals().notifier.handleCallback({
    id: "cbq-1",
    from: { id: fromId },
    data,
  });
}

test("e2e approve: original response released to the agent", async () => {
  const res = await injectWithDecision(async (b) => {
    await callback(b.approve);
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, HELD_RESPONSE, "approved response must be the original bytes");
  // The notification listed the call and its classification.
  const text = String(sentMessages.at(-1)!.text);
  assert.match(text, /shell_exec/);
  assert.match(text, /IRREVERSIBLE_HIGH/);
  assert.match(text, /CREDENTIAL_ACCESS/);
});

test("e2e deny: synthetic denial returned, mirroring id/model/usage", async () => {
  const res = await injectWithDecision(async (b) => {
    await callback(b.deny);
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, "gen-h1");
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.usage, { prompt_tokens: 1, completion_tokens: 2 });
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.ok(!("tool_calls" in body.choices[0].message));
  assert.match(body.choices[0].message.content, /denied by the operator/);
});

test("e2e wrong HMAC and wrong chat are rejected; hold then times out to denial", async () => {
  const res = await injectWithDecision(async (b) => {
    // Tampered tag.
    await callback(b.approve.replace(/:[0-9a-f]{16}$/, ":0000000000000000"));
    // Right tag, wrong sender.
    await callback(b.approve, 666);
    // No valid decision arrives → the 2s hold timeout resolves it.
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.choices[0].message.content, /approval window expired/);
  assert.ok(!("tool_calls" in body.choices[0].message));
});

test("e2e ALLOW traffic is untouched by enforcement", async () => {
  upstreamBody = JSON.stringify({
    id: "gen-ok",
    model: "test-model",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.md"}' } },
          ],
        },
      },
    ],
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json", authorization: "Bearer sk-e2e" },
    payload: JSON.stringify({ model: "test-model", stream: false, messages: [] }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, upstreamBody, "ALLOW path must stay byte-identical");
});

test("healthz reports enforce mode", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.json().mode, "enforce");
});

test("e2e audit chain records decisions + hold transitions and verifies", async () => {
  const { verifyFile } = await import("../src/audit.js");
  const { readFile } = await import("node:fs/promises");

  // Flush pending audit writes without closing the shared app: the previous
  // e2e tests above produced holds (approve/deny/timeout) and ALLOW traffic.
  await new Promise((r) => setTimeout(r, 100));

  const result = await verifyFile(auditPath);
  assert.equal(result.ok, true, `chain must verify: ${JSON.stringify(result.firstBreak)}`);

  const entries = (await readFile(auditPath, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(entries[0].type, "genesis");
  const decisions = entries.filter((e) => e.type === "decision");
  const transitions = entries.filter((e) => e.type === "hold_transition");
  assert.ok(decisions.some((e) => e.decision === "HOLD" && e.hold_id && e.enforced === true));
  assert.ok(decisions.some((e) => e.decision === "ALLOW" && e.function_name === "read_file"));
  assert.ok(transitions.some((e) => e.status === "PENDING"));
  assert.ok(transitions.some((e) => e.status === "APPROVED"));
  assert.ok(transitions.some((e) => e.status === "DENIED"));
  assert.ok(transitions.some((e) => e.status === "EXPIRED_TIMEOUT"));
  // Payloads never enter the chain.
  assert.ok(!JSON.stringify(entries).includes("cat .env"), "arguments must not be audited");
  await rm(auditPath, { force: true });
});
