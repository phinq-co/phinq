import type { ObservedToolCall } from "./toolcalls.js";
import { looksLikeSSE } from "./responses.js";

/**
 * Anthropic Messages API governance (`/v1/messages`, used by the Anthropic SDK
 * and Claude-native agents).
 *
 * Third dialect after chat-completions and Responses. Anthropic puts tool calls
 * in the top-level `content[]` array as items of `type: "tool_use"` with a
 * structured `input` object (not a JSON string). We map those to the shared
 * {@link ObservedToolCall} shape so the classifier / corpus / audit / holds are
 * reused unchanged — only extraction and the denial wire-form differ.
 *
 * Read-only and fail-open: any odd shape yields [] rather than throwing.
 */

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Extract every tool_use call from a parsed Anthropic message object. */
export function extractMessagesToolCalls(
  message: unknown,
  requestModel?: string
): ObservedToolCall[] {
  const out: ObservedToolCall[] = [];
  if (typeof message !== "object" || message === null) return out;
  const m = message as Record<string, unknown>;
  const content = Array.isArray(m.content) ? m.content : [];
  const responseModel = strOf(m.model);
  const responseId = strOf(m.id);
  const stopReason = strOf(m.stop_reason);

  let ki = 0;
  for (const itemRaw of content) {
    if (typeof itemRaw !== "object" || itemRaw === null) continue;
    const item = itemRaw as Record<string, unknown>;
    if (item.type !== "tool_use") continue;

    const name = strOf(item.name);
    if (name === undefined) continue;
    // Anthropic `input` is an object; serialize it for the arg-inspecting classifier.
    let args: string | undefined;
    try {
      args = item.input === undefined ? undefined : JSON.stringify(item.input);
    } catch {
      args = undefined;
    }

    let argsParseOk = false;
    if (args !== undefined) {
      try {
        JSON.parse(args);
        argsParseOk = true;
      } catch {
        argsParseOk = false;
      }
    }

    out.push({
      ts: new Date().toISOString(),
      event: "tool_call",
      request_model: requestModel,
      response_model: responseModel,
      response_id: responseId,
      finish_reason: stopReason,
      choice_index: 0,
      call_index: ki++,
      tool_call_id: strOf(item.id),
      call_type: "tool_use",
      function_name: name,
      arguments: args,
      args_parse_ok: argsParseOk,
      args_bytes: args === undefined ? 0 : Buffer.byteLength(args, "utf8"),
    });
  }
  return out;
}

/**
 * Return the full Anthropic message object from an upstream body, whether it
 * came back as a single JSON object (`stream:false`) or an SSE event stream
 * (`stream:true`). Streaming messages arrive as deltas — `message_start`,
 * `content_block_start`, `content_block_delta` (`input_json_delta` /
 * `text_delta`), `content_block_stop`, `message_delta` — so we replay them into
 * a complete message. Returns null if nothing parseable is found.
 */
export function parseMessagesBody(
  bodyText: string,
  contentType?: string
): Record<string, unknown> | null {
  if (!looksLikeSSE(bodyText, contentType)) {
    try {
      return JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return replayMessagesSSE(bodyText);
}

function replayMessagesSSE(bodyText: string): Record<string, unknown> | null {
  let message: Record<string, unknown> | null = null;
  const blocks: Record<string, unknown>[] = [];
  const jsonBuf: Record<number, string> = {}; // per-index input_json_delta accumulator

  const finalizeBlock = (index: number) => {
    const block = blocks[index];
    if (!block) return;
    if (block.type === "tool_use" && jsonBuf[index] !== undefined) {
      try {
        block.input = JSON.parse(jsonBuf[index]);
      } catch {
        /* leave whatever input was there */
      }
    }
  };

  for (const line of bodyText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }

    switch (ev.type) {
      case "message_start": {
        const msg = ev.message;
        if (msg && typeof msg === "object") message = { ...(msg as Record<string, unknown>) };
        break;
      }
      case "content_block_start": {
        const index = typeof ev.index === "number" ? ev.index : blocks.length;
        const cb = ev.content_block;
        blocks[index] = cb && typeof cb === "object" ? { ...(cb as Record<string, unknown>) } : {};
        if (blocks[index].type === "tool_use") jsonBuf[index] = "";
        break;
      }
      case "content_block_delta": {
        const index = typeof ev.index === "number" ? ev.index : 0;
        const delta = ev.delta as Record<string, unknown> | undefined;
        if (!delta) break;
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          jsonBuf[index] = (jsonBuf[index] ?? "") + delta.partial_json;
        } else if (delta.type === "text_delta" && typeof delta.text === "string") {
          const b = blocks[index] ?? (blocks[index] = { type: "text", text: "" });
          b.text = (typeof b.text === "string" ? b.text : "") + delta.text;
        }
        break;
      }
      case "content_block_stop": {
        finalizeBlock(typeof ev.index === "number" ? ev.index : 0);
        break;
      }
      case "message_delta": {
        const delta = ev.delta as Record<string, unknown> | undefined;
        if (message && delta && typeof delta === "object") Object.assign(message, delta);
        break;
      }
    }
  }

  // Finalize any tool_use blocks not explicitly stopped, then attach content.
  blocks.forEach((_, i) => finalizeBlock(i));
  if (message) message.content = blocks.filter(Boolean);
  return message;
}

/**
 * Build an Anthropic-shaped denial from a held message body — the analog of the
 * chat path's `syntheticDenial`. Replaces `content[]` with a single text block
 * and **no `tool_use`**, `stop_reason: "end_turn"`, so the agent sees a plain
 * answer with nothing to execute. Returned in the held body's wire form (a JSON
 * message, or a minimal valid Anthropic SSE sequence).
 */
export function syntheticMessagesDenial(
  heldBody: string,
  contentType: string,
  reason: string
): { body: string; contentType: string } {
  const held = parseMessagesBody(heldBody, contentType) ?? {};
  const text =
    `Action withheld by Phinq governance (${reason}). ` +
    `The proposed tool call was not executed.`;
  const id = typeof held.id === "string" ? held.id : "msg_phinq_denied";
  const model = held.model;
  const usage =
    held.usage && typeof held.usage === "object"
      ? held.usage
      : { input_tokens: 0, output_tokens: 0 };

  const denial: Record<string, unknown> = {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };

  if (!looksLikeSSE(heldBody, contentType)) {
    return { body: JSON.stringify(denial), contentType: "application/json" };
  }

  const sse = (event: string, data: Record<string, unknown>) =>
    `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

  const body =
    sse("message_start", {
      message: { ...denial, content: [], stop_reason: null },
    }) +
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
    sse("content_block_stop", { index: 0 }) +
    sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage }) +
    sse("message_stop", {});

  return { body, contentType: "text/event-stream" };
}
