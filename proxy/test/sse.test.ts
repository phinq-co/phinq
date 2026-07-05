import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletionToSSE } from "../src/sse.js";

/** Parse the non-[DONE] data frames of an SSE payload back into objects. */
function dataFrames(sse: string): Record<string, unknown>[] {
  return sse
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

test("chatCompletionToSSE reconstructs content and terminates with [DONE]", () => {
  const sse = chatCompletionToSSE(
    JSON.stringify({
      id: "gen-1",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi world" }, finish_reason: "stop" }],
    })
  );
  assert.ok(sse.trimEnd().endsWith("data: [DONE]"));
  const chunks = dataFrames(sse);
  assert.equal(chunks.map((c: any) => c.choices?.[0]?.delta?.content ?? "").join(""), "hi world");
  assert.ok(chunks.some((c: any) => c.choices?.[0]?.finish_reason === "stop"));
});

test("chatCompletionToSSE omits the usage chunk unless the client opted in", () => {
  const body = JSON.stringify({
    id: "gen-u",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { total_tokens: 4 },
  });

  // Default: no stream_options.include_usage → no empty-choices usage chunk
  // (which crashes clients that index choices[0] on every chunk).
  const without = dataFrames(chatCompletionToSSE(body));
  assert.ok(
    without.every((c: any) => Array.isArray(c.choices) && c.choices.length > 0),
    "no chunk may carry an empty choices array by default"
  );
  assert.ok(!without.some((c: any) => c.usage), "usage must not ride an unrequested stream");

  // Opted in: the trailing usage chunk appears, mirroring OpenAI's contract.
  const withUsage = dataFrames(chatCompletionToSSE(body, { includeUsage: true }));
  assert.ok(withUsage.some((c: any) => c.usage?.total_tokens === 4));
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
  const tc = dataFrames(sse).flatMap((c: any) => c.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(tc.length, 1);
  assert.equal(tc[0].function.name, "delete_db");
});

test("chatCompletionToSSE preserves provider-specific fields (reasoning, function_call, refusal)", () => {
  const sse = chatCompletionToSSE(
    JSON.stringify({
      id: "gen-3",
      model: "deepseek/deepseek-r1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "the answer",
            reasoning: "chain of thought tokens",
            function_call: { name: "legacy_fn", arguments: "{}" },
            refusal: null,
          },
          finish_reason: "stop",
        },
      ],
    })
  );
  const deltas = dataFrames(sse).map((c: any) => c.choices?.[0]?.delta ?? {});
  const merged = Object.assign({}, ...deltas);
  assert.equal(merged.content, "the answer");
  assert.equal(merged.reasoning, "chain of thought tokens", "reasoning tokens must survive");
  assert.equal(merged.function_call?.name, "legacy_fn", "legacy function_call must survive");
  // null-valued fields carry no signal and are dropped rather than streamed.
  assert.ok(!("refusal" in merged));
});

test("chatCompletionToSSE surfaces a 200 body that is an error with no choices", () => {
  const sse = chatCompletionToSSE(
    JSON.stringify({ error: { message: "Provider returned error", code: 502 } })
  );
  const frames = dataFrames(sse);
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as any).error?.message, "Provider returned error");
  assert.ok(sse.trimEnd().endsWith("data: [DONE]"));
});

test("chatCompletionToSSE passes multi-line non-JSON through without breaking framing", () => {
  const body = "<!DOCTYPE html>\ndata: not-a-real-frame\n<h1>502 Bad Gateway</h1>";
  const sse = chatCompletionToSSE(body);

  // Exactly two events: the preserved body (one multi-line event) and [DONE].
  const events = sse.split("\n\n").filter((e) => e.trim().length > 0);
  assert.equal(events.length, 2, "must not fan a multi-line body out into extra events");
  assert.ok(sse.trimEnd().endsWith("data: [DONE]"));

  // Every physical line of the first event is a `data:` line (nothing leaks as
  // a bare line the SSE parser would drop, and the embedded 'data:' line does
  // not inject a spurious frame).
  for (const line of events[0].split("\n")) {
    assert.ok(line.startsWith("data: "), `line must be a data field: ${line}`);
  }
  // The full original text is recoverable by stripping the data: prefixes.
  const recovered = events[0]
    .split("\n")
    .map((l) => l.slice("data: ".length))
    .join("\n");
  assert.equal(recovered, body);
});
