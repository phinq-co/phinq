import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import {
  extractGeminiToolCalls,
  parseGeminiBody,
  syntheticGeminiDenial,
  geminiModelFromUrl,
  geminiWireForm,
} from "../src/gemini.js";
import { buildServer, scrubUrl } from "../src/server.js";
import type { ProxyConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Pure units
// ---------------------------------------------------------------------------

const GEMINI_RESPONSE = {
  responseId: "resp-1",
  modelVersion: "gemini-2.5-flash",
  candidates: [
    {
      index: 0,
      finishReason: "STOP",
      content: {
        role: "model",
        parts: [
          { text: "Deleting now." },
          { functionCall: { name: "run_shell", args: { cmd: "rm -rf /data" } } },
        ],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
};

test("extractGeminiToolCalls pulls functionCall parts with serialized args", () => {
  const calls = extractGeminiToolCalls(GEMINI_RESPONSE, "gemini-2.5-flash");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function_name, "run_shell");
  assert.equal(calls[0].arguments, '{"cmd":"rm -rf /data"}');
  assert.equal(calls[0].args_parse_ok, true);
  assert.equal(calls[0].response_model, "gemini-2.5-flash");
  assert.equal(calls[0].response_id, "resp-1");
});

test("parseGeminiBody merges a JSON-array chunk stream", () => {
  const chunks = [
    {
      responseId: "resp-2",
      modelVersion: "gemini-2.5-flash",
      candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Working" }] } }],
    },
    {
      candidates: [
        {
          index: 0,
          finishReason: "STOP",
          content: { parts: [{ functionCall: { name: "send_email", args: { to: "a@b.c" } } }] },
        },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
    },
  ];
  const merged = parseGeminiBody(JSON.stringify(chunks), "application/json");
  assert.ok(merged);
  const calls = extractGeminiToolCalls(merged);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function_name, "send_email");
  assert.equal(calls[0].finish_reason, "STOP");
  assert.deepEqual(merged!.usageMetadata, chunks[1].usageMetadata);
});

test("parseGeminiBody merges an SSE chunk stream (?alt=sse)", () => {
  const sse =
    `data: ${JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ text: "hm" }] } }] })}\n\n` +
    `data: ${JSON.stringify({
      candidates: [
        { index: 0, finishReason: "STOP", content: { parts: [{ functionCall: { name: "delete_all", args: {} } }] } },
      ],
    })}\n\n`;
  const merged = parseGeminiBody(sse, "text/event-stream");
  assert.ok(merged);
  const calls = extractGeminiToolCalls(merged);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function_name, "delete_all");
});

test("syntheticGeminiDenial matches the held body's wire form", () => {
  const json = syntheticGeminiDenial(JSON.stringify(GEMINI_RESPONSE), "application/json", "denied");
  const parsed = JSON.parse(json.body);
  assert.equal(parsed.candidates[0].finishReason, "STOP");
  assert.match(parsed.candidates[0].content.parts[0].text, /withheld by Phinq/);
  assert.ok(!JSON.stringify(parsed).includes("functionCall"));

  const arr = syntheticGeminiDenial(JSON.stringify([GEMINI_RESPONSE]), "application/json", "denied");
  assert.ok(Array.isArray(JSON.parse(arr.body)));

  const sse = syntheticGeminiDenial(
    `data: ${JSON.stringify(GEMINI_RESPONSE)}\n\n`,
    "text/event-stream",
    "timeout"
  );
  assert.equal(sse.contentType, "text/event-stream");
  assert.ok(sse.body.startsWith("data: "));
});

test("geminiModelFromUrl and wire-form detection", () => {
  assert.equal(
    geminiModelFromUrl("/v1beta/models/gemini-2.5-pro:generateContent?key=x"),
    "gemini-2.5-pro"
  );
  assert.equal(geminiModelFromUrl("/v1beta/models"), undefined);
  assert.equal(geminiWireForm("[{}]", "application/json"), "array");
  assert.equal(geminiWireForm("{}", "application/json"), "json");
  assert.equal(geminiWireForm("data: {}", "text/event-stream"), "sse");
});

test("scrubUrl removes Gemini ?key= values from anything logged", () => {
  assert.equal(
    scrubUrl("/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSecret123&alt=sse"),
    "/v1beta/models/gemini-2.5-flash:generateContent?key=<redacted>&alt=sse"
  );
  assert.equal(scrubUrl("/v1/chat/completions"), "/v1/chat/completions");
});

// ---------------------------------------------------------------------------
// Integration: governed Gemini route + universal HTTP gate
// ---------------------------------------------------------------------------

let upstream: http.Server;
let upstreamPort = 0;
let lastUrl = "";
let nextBody = "{}";
let shadowApp: ReturnType<typeof buildServer>;
let enforceApp: ReturnType<typeof buildServer>;
const holdDb = join(tmpdir(), `phinq-gemini-holds-${process.pid}.db`);

function baseConfig(): ProxyConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    upstream: `http://127.0.0.1:${upstreamPort}`,
    anthropicUpstream: `http://127.0.0.1:${upstreamPort}`,
    geminiUpstream: `http://127.0.0.1:${upstreamPort}`,
    upstreamTimeoutMs: 2000,
    toolCallLogPath: "",
    phinqConfigPath: "/nonexistent/phinq.yaml",
    sessionDbPath: ":memory:",
    holdDbPath: ":memory:",
    auditLogPath: "",
    enforce: false,
    holdTimeoutSeconds: 5,
    telegramApiBase: "http://127.0.0.1:1",
    slackOperatorIds: [],
    slackApiBase: "http://127.0.0.1:1",
  };
}

before(async () => {
  await rm(holdDb, { force: true });
  upstream = http.createServer((req, res) => {
    lastUrl = req.url!;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(nextBody);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as { port: number }).port;

  shadowApp = buildServer(baseConfig());
  await shadowApp.ready();

  enforceApp = buildServer({ ...baseConfig(), enforce: true, holdDbPath: holdDb });
  await enforceApp.ready();
});

after(async () => {
  await shadowApp.close();
  await enforceApp.close();
  upstream.close();
  await rm(holdDb, { force: true });
});

test("gemini generateContent is governed: forwarded to the Gemini upstream, relayed verbatim in shadow", async () => {
  nextBody = JSON.stringify(GEMINI_RESPONSE);
  const res = await shadowApp.inject({
    method: "POST",
    url: "/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaTest",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, nextBody, "shadow mode must relay the body verbatim");
  assert.equal(
    lastUrl,
    "/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaTest",
    "path + query (incl. key) must reach the Gemini upstream intact"
  );
});

test("other /v1beta paths blind-proxy to the Gemini upstream", async () => {
  nextBody = JSON.stringify({ models: [] });
  const res = await shadowApp.inject({ method: "GET", url: "/v1beta/models?key=AIzaTest" });
  assert.equal(res.statusCode, 200);
  assert.equal(lastUrl, "/v1beta/models?key=AIzaTest");
});

test("gemini HOLD is enforced: deny yields a Gemini-shaped denial with no functionCall", async () => {
  nextBody = JSON.stringify(GEMINI_RESPONSE); // rm -rf → BULK_DELETE → HOLD
  const pending = enforceApp.inject({
    method: "POST",
    url: "/v1beta/models/gemini-2.5-flash:generateContent",
    headers: { "content-type": "application/json", "x-goog-api-key": "AIzaTest" },
    payload: JSON.stringify({ contents: [] }),
  });

  // Wait for the hold to appear, then deny it via the store.
  const holds = (enforceApp as unknown as { phinq: { holds: { listPending(): { id: string }[]; decide(id: string, d: string, by: string): unknown } } }).phinq.holds;
  let id: string | undefined;
  for (let i = 0; i < 100 && !id; i++) {
    await new Promise((r) => setTimeout(r, 20));
    id = holds.listPending()[0]?.id;
  }
  assert.ok(id, "a hold must be created for the Gemini functionCall");
  holds.decide(id!, "deny", "test:operator");

  const res = await pending;
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.match(body.candidates[0].content.parts[0].text, /withheld by Phinq/);
  assert.ok(!res.body.includes("functionCall"), "denial must carry no executable call");
});

/** Poll the enforce app's hold store until a hold appears (or give up). */
async function firstPendingHold(): Promise<{
  id: string;
  holds: { decide(id: string, d: string, by: string): unknown };
}> {
  const holds = (
    enforceApp as unknown as {
      phinq: { holds: { listPending(): { id: string }[]; decide(id: string, d: string, by: string): unknown } };
    }
  ).phinq.holds;
  for (let i = 0; i < 100; i++) {
    const id = holds.listPending()[0]?.id;
    if (id) return { id, holds };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("hold never appeared");
}

test("/v1beta/openai/chat/completions is governed on the Gemini upstream (not a silent bypass)", async () => {
  // Google's OpenAI-compat surface returns OpenAI-shaped tool calls; a
  // dangerous one must be held, not relayed through untouched.
  nextBody = JSON.stringify({
    id: "cmpl-compat",
    model: "gemini-2.5-flash",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "shell_exec", arguments: '{"cmd":"sudo rm -rf /"}' } },
          ],
        },
      },
    ],
  });
  const pending = enforceApp.inject({
    method: "POST",
    url: "/v1beta/openai/chat/completions",
    headers: { "content-type": "application/json", authorization: "Bearer AIzaTest" },
    payload: JSON.stringify({ model: "gemini-2.5-flash", messages: [] }),
  });

  const { id, holds } = await firstPendingHold();
  assert.equal(lastUrl, "/v1beta/openai/chat/completions", "compat request must reach the Gemini upstream verbatim");
  holds.decide(id, "deny", "test:operator");

  const res = await pending;
  const body = JSON.parse(res.body);
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.ok(!("tool_calls" in body.choices[0].message), "denied compat call carries no executable tool call");
});

test("api_version 'v1' generateContent is governed as Gemini, not misrouted to the default upstream", async () => {
  nextBody = JSON.stringify(GEMINI_RESPONSE); // rm -rf → HOLD
  const pending = enforceApp.inject({
    method: "POST",
    url: "/v1/models/gemini-2.5-flash:generateContent",
    headers: { "content-type": "application/json", "x-goog-api-key": "AIzaTest" },
    payload: JSON.stringify({ contents: [] }),
  });

  const { id, holds } = await firstPendingHold();
  // Governed Gemini preserves the path; a misroute into the /v1/* OpenAI
  // catch-all would have normalized it to /api/v1/....
  assert.equal(lastUrl, "/v1/models/gemini-2.5-flash:generateContent");
  holds.decide(id, "deny", "test:operator");

  const res = await pending;
  const body = JSON.parse(res.body);
  assert.match(body.candidates[0].content.parts[0].text, /withheld by Phinq/);
});

test("POST /phinq/classify is a pure advisory lookup", async () => {
  const res = await shadowApp.inject({
    method: "POST",
    url: "/phinq/classify",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ name: "shell_exec", arguments: { cmd: "sudo rm -rf /" } }),
  });
  assert.equal(res.statusCode, 200);
  const c = res.json();
  assert.equal(c.decision, "HOLD");
  assert.equal(c.action_class, "IRREVERSIBLE_HIGH");
  assert.ok(c.triggers.includes("PERMISSION_ESCALATION"));
});

test("POST /phinq/gate allows safe calls and flags shadow HOLDs", async () => {
  const safe = await shadowApp.inject({
    method: "POST",
    url: "/phinq/gate",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ name: "list_files", arguments: { path: "." } }),
  });
  assert.equal(safe.json().allowed, true);

  const risky = await shadowApp.inject({
    method: "POST",
    url: "/phinq/gate",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ name: "delete_database", session_key: "n8n-workflow-7" }),
  });
  const r = risky.json();
  assert.equal(r.allowed, true, "shadow mode never blocks");
  assert.equal(r.shadow, true);
  assert.equal(r.classification.decision, "HOLD");
});

test("POST /phinq/gate blocks in enforce mode until the operator decides", async () => {
  const pending = enforceApp.inject({
    method: "POST",
    url: "/phinq/gate",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      name: "shell_exec",
      arguments: { cmd: "sudo systemctl stop nginx" },
      session_key: "go-agent-1",
      agent: "custom-go-loop",
    }),
  });

  const holds = (enforceApp as unknown as { phinq: { holds: { listPending(): { id: string }[]; decide(id: string, d: string, by: string): unknown } } }).phinq.holds;
  let id: string | undefined;
  for (let i = 0; i < 100 && !id; i++) {
    await new Promise((r) => setTimeout(r, 20));
    id = holds.listPending()[0]?.id;
  }
  assert.ok(id, "gate must create a hold");
  holds.decide(id!, "approve", "test:operator");

  const res = await pending;
  const body = res.json();
  assert.equal(body.allowed, true);
  assert.equal(body.resolution, "APPROVED");
  assert.equal(body.hold_id, id);

  // And a denial comes back allowed:false.
  const pending2 = enforceApp.inject({
    method: "POST",
    url: "/phinq/gate",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ name: "drop_table", session_key: "go-agent-1" }),
  });
  let id2: string | undefined;
  for (let i = 0; i < 100 && !id2; i++) {
    await new Promise((r) => setTimeout(r, 20));
    id2 = holds.listPending()[0]?.id;
  }
  assert.ok(id2);
  holds.decide(id2!, "deny", "test:operator");
  const res2 = await pending2;
  assert.equal(res2.json().allowed, false);
  assert.equal(res2.json().resolution, "DENIED");
});

test("gate rejects bodies without a name", async () => {
  const res = await shadowApp.inject({
    method: "POST",
    url: "/phinq/gate",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ arguments: {} }),
  });
  assert.equal(res.statusCode, 400);
});

test("gate rejects non-object JSON bodies with 400 (not a 500 crash)", async () => {
  // JSON.parse accepts these; dereferencing them as an object would throw.
  for (const payload of ["null", "42", '"hi"', "[1,2,3]"]) {
    for (const url of ["/phinq/gate", "/phinq/classify"]) {
      const res = await shadowApp.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload,
      });
      assert.equal(res.statusCode, 400, `${url} with ${payload} must be 400`);
    }
  }
});

test("PHINQ_GATE_TOKEN, when set, guards /phinq/gate and /phinq/classify", async () => {
  const tokenApp = buildServer({ ...baseConfig(), gateToken: "s3cret-gate" });
  await tokenApp.ready();
  try {
    const body = JSON.stringify({ name: "list_files", arguments: { path: "." } });
    for (const url of ["/phinq/gate", "/phinq/classify"]) {
      // No token → 401
      const noAuth = await tokenApp.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload: body,
      });
      assert.equal(noAuth.statusCode, 401, `${url} without token must be 401`);

      // Wrong token → 401 (and no length-based timing leak crash on mismatch)
      const wrong = await tokenApp.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json", authorization: "Bearer nope" },
        payload: body,
      });
      assert.equal(wrong.statusCode, 401, `${url} with wrong token must be 401`);

      // Correct token → passes through
      const ok = await tokenApp.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json", authorization: "Bearer s3cret-gate" },
        payload: body,
      });
      assert.equal(ok.statusCode, 200, `${url} with correct token must be 200`);
    }
  } finally {
    await tokenApp.close();
  }
});

test("gate is open when PHINQ_GATE_TOKEN is unset (default localhost trust)", async () => {
  // shadowApp has no gateToken — a tokenless request must still be served.
  const res = await shadowApp.inject({
    method: "POST",
    url: "/phinq/classify",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ name: "list_files" }),
  });
  assert.equal(res.statusCode, 200);
});
