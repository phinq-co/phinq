import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { buildServer } from "../src/server.js";
import type { ProxyConfig } from "../src/config.js";

// Enforcement with NO Telegram — holds resolved via the local control API.
let upstream: http.Server;
let app: ReturnType<typeof buildServer>;
let port = 0;
let upstreamBody = "{}";
const holdDb = join(tmpdir(), `phinq-local-holds-${process.pid}.db`);

const HELD = JSON.stringify({
  id: "gen-l1",
  model: "test-model",
  usage: { prompt_tokens: 1, completion_tokens: 1 },
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "shell_exec", arguments: '{"cmd":"sudo reboot"}' } },
        ],
      },
    },
  ],
});

function secret(): string {
  const db = new DatabaseSync(holdDb, { readOnly: true });
  const row = db.prepare("SELECT v FROM meta WHERE k='install_secret'").get() as { v: string };
  db.close();
  return row.v;
}

before(async () => {
  await rm(holdDb, { force: true });
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(upstreamBody);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const config: ProxyConfig = {
    port: 0,
    host: "127.0.0.1",
    upstream: `http://127.0.0.1:${upstreamPort}`,
    upstreamTimeoutMs: 2000,
    toolCallLogPath: "",
    phinqConfigPath: "/nonexistent/phinq.yaml",
    sessionDbPath: ":memory:",
    holdDbPath: holdDb,
    auditLogPath: "",
    enforce: true, // enforce ON
    holdTimeoutSeconds: 2,
    // NO telegram token/chat — local approval only
    telegramApiBase: "http://127.0.0.1:1",
  };
  app = buildServer(config);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});

after(async () => {
  await app.close();
  upstream.close();
  await rm(holdDb, { force: true });
});

const ctl = (path: string, method: string, token: string) =>
  app.inject({ method: method as "GET", url: path, headers: { authorization: `Bearer ${token}` } });

test("enforce works without Telegram (healthz mode=enforce)", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.json().mode, "enforce");
});

test("control API rejects missing/bad token", async () => {
  const noauth = await app.inject({ method: "GET", url: "/phinq/holds" });
  assert.equal(noauth.statusCode, 401);
  const bad = await ctl("/phinq/holds", "GET", "wrongtoken");
  assert.equal(bad.statusCode, 401);
});

/** Fire a governed POST over a REAL socket so the hold stays open (inject
 *  closes the connection immediately, which would trip EXPIRED_CLIENT). */
function realGovernedPost(): Promise<{ status: number; body: string }> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-local" },
    body: JSON.stringify({ model: "test-model", stream: false, messages: [] }),
  }).then(async (r) => ({ status: r.status, body: await r.text() }));
}

/** Same, but asks the proxy to stream — exercises the SSE keep-alive hold path. */
function realGovernedStreamPost(): Promise<{ status: number; contentType: string; body: string }> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-local-stream" },
    body: JSON.stringify({ model: "test-model", stream: true, messages: [] }),
  }).then(async (r) => ({
    status: r.status,
    contentType: r.headers.get("content-type") ?? "",
    body: await r.text(),
  }));
}

async function waitForHold(): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const holds = (await ctl("/phinq/holds", "GET", secret())).json().holds;
    if (holds.length) return holds[0].id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("hold never appeared");
}

test("hold is listed locally and approve releases the original response", async () => {
  upstreamBody = HELD;
  const pending = realGovernedPost();

  const id = await waitForHold();
  const holds = (await ctl("/phinq/holds", "GET", secret())).json().holds;
  assert.equal(holds[0].calls[0].function_name, "shell_exec");
  assert.equal(holds[0].calls[0].action_class, "IRREVERSIBLE_HIGH");
  assert.ok(holds[0].calls[0].triggers.includes("PERMISSION_ESCALATION"));

  const dec = await ctl(`/phinq/holds/${id}/approve`, "POST", secret());
  assert.equal(dec.json().result, "applied");
  assert.equal(dec.json().status, "APPROVED");

  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body, HELD, "approved hold releases the original bytes");
});

test("deny returns a synthetic denial with no tool_calls", async () => {
  upstreamBody = HELD;
  const pending = realGovernedPost();
  const id = await waitForHold();
  await ctl(`/phinq/holds/${id}/deny`, "POST", secret());
  const body = JSON.parse((await pending).body);
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.ok(!("tool_calls" in body.choices[0].message));
  assert.match(body.choices[0].message.content, /denied by the operator/);
});

test("streaming hold keeps the socket warm, then approve streams the reconstructed result", async () => {
  upstreamBody = HELD;
  const pending = realGovernedStreamPost();
  const id = await waitForHold();
  await ctl(`/phinq/holds/${id}/approve`, "POST", secret());

  const res = await pending;
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/event-stream/, "streaming hold must answer as SSE");
  // A keep-alive comment is sent up front so the client's idle timer holds.
  assert.ok(res.body.includes(": phinq awaiting operator decision"), "keep-alive preamble missing");
  assert.ok(res.body.trimEnd().endsWith("data: [DONE]"));
  // The approved tool call is reconstructed into the stream.
  const toolNames = res.body
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .flatMap((l) => {
      try {
        return (JSON.parse(l.slice(6)).choices?.[0]?.delta?.tool_calls ?? []) as { function?: { name?: string } }[];
      } catch {
        return [];
      }
    })
    .map((tc) => tc.function?.name);
  assert.ok(toolNames.includes("shell_exec"), "approved streaming hold must carry the tool call");
});

test("streaming hold: deny streams a synthetic denial with no tool_calls", async () => {
  upstreamBody = HELD;
  const pending = realGovernedStreamPost();
  const id = await waitForHold();
  await ctl(`/phinq/holds/${id}/deny`, "POST", secret());

  const res = await pending;
  assert.match(res.contentType, /text\/event-stream/);
  assert.ok(!res.body.includes("tool_calls"), "denied stream must carry no tool call");
  assert.match(res.body, /denied by the operator/);
  assert.ok(res.body.trimEnd().endsWith("data: [DONE]"));
});

test("deciding an unknown hold reports unknown", async () => {
  const dec = await ctl("/phinq/holds/nope/approve", "POST", secret());
  assert.equal(dec.json().result, "unknown");
});
