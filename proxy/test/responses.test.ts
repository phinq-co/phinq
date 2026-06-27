import { test } from "node:test";
import assert from "node:assert/strict";
import { extractResponsesToolCalls, parseResponsesBody } from "../src/responses.js";

// A minimal Responses API object with a function_call in output[] —
// the exact shape OpenRouter/OpenAI return for Codex (wire_api=responses).
const responseWithFunctionCall = {
  id: "resp_1",
  object: "response",
  model: "openai/gpt-oss-120b",
  output: [
    { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }] },
    {
      id: "fc_1",
      type: "function_call",
      status: "completed",
      call_id: "call_abc",
      name: "exec_command",
      arguments: '{"cmd":"ls -la"}',
    },
  ],
};

test("extracts a function_call from output[] with name + raw arguments", () => {
  const calls = extractResponsesToolCalls(responseWithFunctionCall, "req-model");
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.function_name, "exec_command");
  assert.equal(c.arguments, '{"cmd":"ls -la"}');
  assert.equal(c.call_type, "function_call");
  assert.equal(c.tool_call_id, "call_abc");
  assert.equal(c.response_model, "openai/gpt-oss-120b");
  assert.equal(c.request_model, "req-model");
  assert.equal(c.args_parse_ok, true);
});

test("ignores non-call items (reasoning, message)", () => {
  const calls = extractResponsesToolCalls({
    output: [
      { type: "reasoning" },
      { type: "message", content: [{ type: "output_text", text: "hi" }] },
    ],
  });
  assert.equal(calls.length, 0);
});

test("maps a local_shell_call to name 'local_shell' with the action as arguments", () => {
  const calls = extractResponsesToolCalls({
    output: [
      {
        type: "local_shell_call",
        call_id: "ls_1",
        action: { type: "exec", command: ["bash", "-lc", "rm -rf /tmp/x"] },
      },
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function_name, "local_shell");
  assert.match(calls[0].arguments ?? "", /rm -rf/);
});

test("governs an unknown *_call keyed by its type (zero false-negative posture)", () => {
  const calls = extractResponsesToolCalls({
    output: [{ type: "mystery_call", action: { foo: 1 } }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function_name, "mystery_call");
});

test("flags a *_call that yields no usable name via the callback", () => {
  const seen: string[] = [];
  const calls = extractResponsesToolCalls(
    { output: [{ type: "function_call" }] }, // no name field
    undefined,
    (t) => seen.push(t)
  );
  assert.deepEqual(seen, ["function_call"]);
  assert.equal(calls.length, 0);
});

test("malformed input yields [] rather than throwing", () => {
  assert.deepEqual(extractResponsesToolCalls(null), []);
  assert.deepEqual(extractResponsesToolCalls({}), []);
  assert.deepEqual(extractResponsesToolCalls({ output: "nope" }), []);
});

test("parseResponsesBody reads a plain JSON body", () => {
  const obj = parseResponsesBody(JSON.stringify(responseWithFunctionCall), "application/json");
  assert.ok(obj);
  assert.equal((obj as { id?: string }).id, "resp_1");
});

test("parseResponsesBody extracts the response from an SSE stream", () => {
  const sse =
    `event: response.created\n` +
    `data: {"type":"response.created","response":{"id":"resp_2"}}\n\n` +
    `event: response.completed\n` +
    `data: {"type":"response.completed","response":${JSON.stringify(responseWithFunctionCall)}}\n\n`;
  const obj = parseResponsesBody(sse, "text/event-stream");
  assert.ok(obj);
  const calls = extractResponsesToolCalls(obj);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function_name, "exec_command");
});
