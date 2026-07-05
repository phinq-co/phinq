import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, normalizeUpstreamPath } from "../src/server.js";
import { extractToolCalls } from "../src/toolcalls.js";
import type { ProxyConfig } from "../src/config.js";

/** Mock upstream that records the last request and returns a canned reply. */
interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let upstream: http.Server;
let upstreamPort: number;
let lastRequest: Recorded | null = null;
let nextResponse: { status: number; headers?: Record<string, string>; body: string } = {
  status: 200,
  body: "{}",
};

let app: ReturnType<typeof buildServer>;

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastRequest = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      res.writeHead(nextResponse.status, {
        "content-type": "application/json",
        ...nextResponse.headers,
      });
      res.end(nextResponse.body);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as { port: number }).port;

  const config: ProxyConfig = {
    port: 0,
    host: "127.0.0.1",
    upstream: `http://127.0.0.1:${upstreamPort}`,
    upstreamTimeoutMs: 2000,
    toolCallLogPath: "", // corpus capture disabled for the shared instance
    phinqConfigPath: "/nonexistent/phinq.yaml",
    sessionDbPath: ":memory:",
    holdDbPath: ":memory:",
    auditLogPath: "",
    enforce: false,
    holdTimeoutSeconds: 240,
    telegramApiBase: "http://127.0.0.1:1",
  };
  app = buildServer(config);
  await app.ready();
});

after(async () => {
  await app.close();
  upstream.close();
});

test("health endpoint", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().service, "phinq-proxy");
});

test("path normalization", () => {
  assert.equal(normalizeUpstreamPath("/v1/models"), "/api/v1/models");
  assert.equal(normalizeUpstreamPath("/api/v1/models"), "/api/v1/models");
  assert.equal(normalizeUpstreamPath("/v1/models?q=1"), "/api/v1/models?q=1");
});

test("stream:true fetches non-streamed upstream and re-streams the governed result as SSE", async () => {
  // Both base-URL prefixes an OpenAI SDK / Hermes can produce must stream.
  for (const url of ["/v1/chat/completions", "/api/v1/chat/completions"]) {
    nextResponse = {
      status: 200,
      body: JSON.stringify({
        id: "gen-stream-1",
        model: "openai/gpt-4o-mini",
        choices: [{ index: 0, message: { role: "assistant", content: "hello there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    };

    const res = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", authorization: "Bearer sk-stream" },
      payload: JSON.stringify({
        model: "openai/gpt-4o-mini",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(res.statusCode, 200, `${url} streams`);
    assert.match(res.headers["content-type"] as string, /text\/event-stream/);
    // Upstream must have been asked for a NON-streamed completion with no
    // stream_options (which only makes sense on a real stream).
    const forwarded = JSON.parse(lastRequest!.body.toString());
    assert.equal(forwarded.stream, false, `${url}: upstream must receive stream:false`);
    assert.equal(forwarded.stream_options, undefined, `${url}: stream_options must be dropped`);
    // Client receives SSE frames terminated by [DONE], reconstructing the content.
    assert.ok(res.body.includes("data: "), "must emit SSE data frames");
    assert.ok(res.body.trimEnd().endsWith("data: [DONE]"), "must terminate with [DONE]");
    const reconstructed = res.body
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)))
      .map((c) => c.choices?.[0]?.delta?.content ?? "")
      .join("");
    assert.equal(reconstructed, "hello there", `${url}: content must survive the round-trip`);
  }
});

test("stream:false chat completion forwards byte-identical and returns upstream verbatim", async () => {
  const payload = JSON.stringify({
    model: "openai/gpt-4o-mini",
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  });
  nextResponse = {
    status: 200,
    headers: { "x-upstream-custom": "preserved" },
    body: JSON.stringify({
      id: "gen-1",
      choices: [{ message: { role: "assistant", tool_calls: [{ function: { name: "send_email" } }] } }],
    }),
  };

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-test-123",
    },
    payload,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, nextResponse.body, "response body must be verbatim");
  assert.equal(res.headers["x-upstream-custom"], "preserved");
  assert.equal(lastRequest!.url, "/api/v1/chat/completions");
  assert.equal(lastRequest!.body.toString(), payload, "request body must be byte-identical");
  assert.equal(lastRequest!.headers.authorization, "Bearer sk-test-123", "auth must pass through");
  assert.equal(lastRequest!.headers.host, `127.0.0.1:${upstreamPort}`, "host must be rewritten");
});

test("upstream non-200 passes through unchanged", async () => {
  nextResponse = {
    status: 429,
    headers: { "retry-after": "30" },
    body: JSON.stringify({ error: { message: "rate limited" } }),
  };
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["retry-after"], "30");
  assert.equal(res.json().error.message, "rate limited");
});

test("blind passthrough covers other /v1 paths with query strings", async () => {
  nextResponse = { status: 200, body: JSON.stringify({ data: ["model-a"] }) };
  const res = await app.inject({
    method: "GET",
    url: "/v1/models?supported_parameters=tools",
    headers: { authorization: "Bearer sk-test-123" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(lastRequest!.url, "/api/v1/models?supported_parameters=tools");
  assert.equal(lastRequest!.headers.authorization, "Bearer sk-test-123");
});

test("unparseable JSON forwards verbatim — upstream is the authority", async () => {
  nextResponse = { status: 400, body: JSON.stringify({ error: { message: "bad json" } }) };
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    payload: "{not json",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(lastRequest!.body.toString(), "{not json");
});

test("unreachable upstream returns 502 with OpenAI-style error", async () => {
  const config: ProxyConfig = {
    port: 0,
    host: "127.0.0.1",
    upstream: "http://127.0.0.1:1", // nothing listens here
    upstreamTimeoutMs: 1000,
    toolCallLogPath: "",
    phinqConfigPath: "/nonexistent/phinq.yaml",
    sessionDbPath: ":memory:",
    holdDbPath: ":memory:",
    auditLogPath: "",
    enforce: false,
    holdTimeoutSeconds: 240,
    telegramApiBase: "http://127.0.0.1:1",
  };
  const dead = buildServer(config);
  await dead.ready();
  const res = await dead.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error.code, "upstream_unreachable");
  await dead.close();
});

// ---------------------------------------------------------------------------
// Component 2 — tool call inspection
// ---------------------------------------------------------------------------

test("extractToolCalls pulls name + arguments from every choice", () => {
  const calls = extractToolCalls(
    {
      id: "gen-42",
      model: "anthropic/claude-sonnet-4-6",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "send_email", arguments: '{"to":"a@b.co"}' },
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "read_file", arguments: "{broken json" },
              },
            ],
          },
        },
      ],
    },
    "requested-model"
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].function_name, "send_email");
  assert.equal(calls[0].arguments, '{"to":"a@b.co"}');
  assert.equal(calls[0].args_parse_ok, true);
  assert.equal(calls[0].request_model, "requested-model");
  assert.equal(calls[0].response_model, "anthropic/claude-sonnet-4-6");
  assert.equal(calls[0].response_id, "gen-42");
  assert.equal(calls[0].finish_reason, "tool_calls");
  assert.equal(calls[0].tool_call_id, "call_1");
  // Broken arguments JSON is recorded raw and flagged — that's calibration signal.
  assert.equal(calls[1].function_name, "read_file");
  assert.equal(calls[1].args_parse_ok, false);
  assert.equal(calls[1].arguments, "{broken json");
});

test("extractToolCalls is defensive about odd shapes", () => {
  assert.deepEqual(extractToolCalls(null), []);
  assert.deepEqual(extractToolCalls("nope"), []);
  assert.deepEqual(extractToolCalls({}), []);
  assert.deepEqual(extractToolCalls({ choices: [{ message: {} }] }), []);
  assert.deepEqual(extractToolCalls({ choices: [{ message: { tool_calls: "x" } }] }), []);
  // A call entry missing its function block still produces a (flagged) record.
  const partial = extractToolCalls({
    choices: [{ message: { tool_calls: [{ id: "call_x" }] } }],
  });
  assert.equal(partial.length, 1);
  assert.equal(partial[0].function_name, undefined);
  assert.equal(partial[0].args_bytes, 0);
});

test("tool calls in relayed responses land in the JSONL corpus, response stays verbatim", async () => {
  const corpusPath = join(tmpdir(), `phinq-toolcalls-test-${process.pid}.jsonl`);
  await rm(corpusPath, { force: true });

  const config: ProxyConfig = {
    port: 0,
    host: "127.0.0.1",
    upstream: `http://127.0.0.1:${upstreamPort}`,
    upstreamTimeoutMs: 2000,
    toolCallLogPath: corpusPath,
    phinqConfigPath: "/nonexistent/phinq.yaml",
    sessionDbPath: ":memory:",
    holdDbPath: ":memory:",
    auditLogPath: "",
    enforce: false,
    holdTimeoutSeconds: 240,
    telegramApiBase: "http://127.0.0.1:1",
  };
  const inspecting = buildServer(config);
  await inspecting.ready();

  const upstreamBody = JSON.stringify({
    id: "gen-7",
    model: "moonshotai/kimi-k2",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "shell_exec", arguments: '{"cmd":"ls"}' } },
            { id: "c2", type: "function", function: { name: "send_email", arguments: '{"to":"x@y.z"}' } },
          ],
        },
      },
    ],
  });
  nextResponse = { status: 200, body: upstreamBody };

  const res = await inspecting.inject({
    method: "POST",
    url: "/api/v1/chat/completions",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ model: "moonshotai/kimi-k2", stream: false, messages: [] }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, upstreamBody, "inspection must not alter the response");

  // No tool calls → nothing appended.
  nextResponse = {
    status: 200,
    body: JSON.stringify({ id: "gen-8", choices: [{ message: { role: "assistant", content: "hi" } }] }),
  };
  await inspecting.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ model: "m", messages: [] }),
  });

  // Upstream errors → not inspected.
  nextResponse = { status: 500, body: JSON.stringify({ error: { message: "boom" } }) };
  await inspecting.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ model: "m", messages: [] }),
  });

  await inspecting.close(); // onClose flushes the corpus

  const lines = (await readFile(corpusPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, "exactly the two tool calls from the 200 response");
  assert.deepEqual(
    lines.map((l) => l.function_name),
    ["shell_exec", "send_email"]
  );
  assert.equal(lines[0].arguments, '{"cmd":"ls"}');
  assert.equal(lines[0].response_id, "gen-7");
  assert.equal(lines[1].tool_call_id, "c2");
  // Component 3: shadow classification annotates every corpus record.
  assert.equal(lines[0].decision, "ALLOW", "plain ls must shadow-ALLOW");
  assert.equal(lines[0].action_class, "REVERSIBLE");
  assert.equal(lines[1].decision, "ALLOW", "single send must shadow-ALLOW");
  assert.equal(lines[1].action_class, "IRREVERSIBLE_LOW");
  assert.ok(Array.isArray(lines[1].reasons) && lines[1].reasons.length > 0);

  await rm(corpusPath, { force: true });
});
