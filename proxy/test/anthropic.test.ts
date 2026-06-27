import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractMessagesToolCalls,
  parseMessagesBody,
  syntheticMessagesDenial,
} from "../src/anthropic.js";
import { classifyToolCall, DEFAULT_RULES } from "../src/classifier.js";

// A real-shaped Anthropic Messages response with a tool_use block.
const messageWithToolUse = {
  id: "msg_01ABC",
  type: "message",
  role: "assistant",
  model: "claude-3-5-sonnet-20241022",
  content: [
    { type: "text", text: "I'll read that file." },
    { type: "tool_use", id: "toolu_01XYZ", name: "run_shell", input: { command: "cat .env" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 40 },
};

// Build an Anthropic SSE stream the way the real API emits it (deltas).
function sse(type: string, rest: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
}
const sseStream =
  sse("message_start", {
    message: {
      id: "msg_01ABC",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  }) +
  sse("content_block_start", {
    index: 0,
    content_block: { type: "tool_use", id: "toolu_01XYZ", name: "run_shell", input: {} },
  }) +
  sse("content_block_delta", {
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"command":' },
  }) +
  sse("content_block_delta", {
    index: 0,
    delta: { type: "input_json_delta", partial_json: '"cat .env"}' },
  }) +
  sse("content_block_stop", { index: 0 }) +
  sse("message_delta", {
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 20 },
  }) +
  sse("message_stop", {});

test("extracts a tool_use from content[] with serialized input", () => {
  const calls = extractMessagesToolCalls(messageWithToolUse, "req-model");
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.function_name, "run_shell");
  assert.equal(c.arguments, '{"command":"cat .env"}');
  assert.equal(c.call_type, "tool_use");
  assert.equal(c.tool_call_id, "toolu_01XYZ");
  assert.equal(c.response_model, "claude-3-5-sonnet-20241022");
  assert.equal(c.request_model, "req-model");
  assert.equal(c.args_parse_ok, true);
});

test("ignores text blocks", () => {
  const calls = extractMessagesToolCalls(
    { content: [{ type: "text", text: "hello" }] },
    undefined
  );
  assert.equal(calls.length, 0);
});

test("parseMessagesBody parses a JSON message", () => {
  const m = parseMessagesBody(JSON.stringify(messageWithToolUse), "application/json");
  assert.ok(m);
  assert.equal((m as any).id, "msg_01ABC");
  assert.equal((m as any).content.length, 2);
});

test("parseMessagesBody reconstructs a streamed message from deltas", () => {
  const m = parseMessagesBody(sseStream, "text/event-stream");
  assert.ok(m);
  assert.equal((m as any).id, "msg_01ABC");
  assert.equal((m as any).stop_reason, "tool_use");
  const tool = (m as any).content.find((b: any) => b.type === "tool_use");
  assert.ok(tool, "tool_use block reconstructed");
  assert.deepEqual(tool.input, { command: "cat .env" });
});

test("extract works on the SSE-reconstructed message", () => {
  const m = parseMessagesBody(sseStream, "text/event-stream");
  const calls = extractMessagesToolCalls(m);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function_name, "run_shell");
  assert.equal(calls[0].arguments, '{"command":"cat .env"}');
});

test("end-to-end: a Messages tool_use classifies through the shared classifier", () => {
  const calls = extractMessagesToolCalls(messageWithToolUse);
  const c = classifyToolCall(
    { name: calls[0].function_name, argumentsJson: calls[0].arguments },
    { sends: 0, deletes: 0, recentError: false },
    DEFAULT_RULES
  );
  assert.equal(c.decision, "HOLD");
  assert.ok(c.triggers.includes("CREDENTIAL_ACCESS"));
});

test("syntheticMessagesDenial (JSON) has a text block and no tool_use", () => {
  const { body, contentType } = syntheticMessagesDenial(
    JSON.stringify(messageWithToolUse),
    "application/json",
    "denied"
  );
  assert.equal(contentType, "application/json");
  const d = JSON.parse(body);
  assert.equal(d.type, "message");
  assert.equal(d.stop_reason, "end_turn");
  assert.equal(d.id, "msg_01ABC"); // mirrors the held id
  assert.ok(d.content.every((b: any) => b.type !== "tool_use"));
  assert.equal(extractMessagesToolCalls(d).length, 0);
});

test("syntheticMessagesDenial (SSE) is valid and parses back to a no-tool message", () => {
  const { body, contentType } = syntheticMessagesDenial(sseStream, "text/event-stream", "timeout");
  assert.equal(contentType, "text/event-stream");
  const reparsed = parseMessagesBody(body, "text/event-stream");
  assert.ok(reparsed);
  assert.equal((reparsed as any).stop_reason, "end_turn");
  assert.equal(extractMessagesToolCalls(reparsed).length, 0);
  const textBlock = (reparsed as any).content.find((b: any) => b.type === "text");
  assert.ok(textBlock && /withheld by Phinq/.test(textBlock.text));
});
