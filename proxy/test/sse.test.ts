import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceNonStream, chatCompletionToSSE } from "../src/sse.js";

test("coerceNonStream forces stream:false and drops stream_options", () => {
  const out = JSON.parse(
    coerceNonStream(
      Buffer.from(JSON.stringify({ model: "m", stream: true, stream_options: { include_usage: true }, messages: [] }))
    ).toString()
  );
  assert.equal(out.stream, false);
  assert.equal(out.stream_options, undefined);
  assert.equal(out.model, "m");
});

test("coerceNonStream leaves unparseable bodies unchanged", () => {
  const raw = Buffer.from("not json");
  assert.equal(coerceNonStream(raw).toString(), "not json");
});

test("chatCompletionToSSE reconstructs content and terminates with [DONE]", () => {
  const sse = chatCompletionToSSE(
    JSON.stringify({
      id: "gen-1",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi world" }, finish_reason: "stop" }],
      usage: { total_tokens: 4 },
    })
  );
  assert.ok(sse.trimEnd().endsWith("data: [DONE]"));
  const chunks = sse
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)));
  assert.equal(chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join(""), "hi world");
  // finish_reason surfaces on a terminal chunk; usage rides a final chunk.
  assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === "stop"));
  assert.ok(chunks.some((c) => c.usage?.total_tokens === 4));
});

test("chatCompletionToSSE carries tool_calls through the delta", () => {
  const sse = chatCompletionToSSE(
    JSON.stringify({
      id: "gen-2",
      model: "m",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "delete_db", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
  );
  const tc = sse
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)))
    .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(tc.length, 1);
  assert.equal(tc[0].function.name, "delete_db");
});

test("chatCompletionToSSE passes non-JSON through as a single frame", () => {
  const sse = chatCompletionToSSE("upstream error text");
  assert.ok(sse.includes("data: upstream error text"));
  assert.ok(sse.trimEnd().endsWith("data: [DONE]"));
});
