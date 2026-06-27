import type { ObservedToolCall } from "./toolcalls.js";

/**
 * Responses API governance (OpenAI `/responses`, used by Codex CLI with
 * `wire_api = "responses"` and any other Responses-based agent).
 *
 * Where chat-completions puts tool calls under `choices[].message.tool_calls`,
 * the Responses API puts them in the top-level `output[]` array as items whose
 * `type` ends in `_call`. We map those to the same {@link ObservedToolCall}
 * shape the classifier/corpus/audit already understand, so the whole governance
 * stack is reused unchanged — only the extraction differs.
 *
 * Read-only and fail-open: any odd shape yields [] rather than throwing, so a
 * parsing surprise can never block or alter the relayed response.
 */

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Serialize a structured argument blob (e.g. a local_shell action) to a stable string. */
function jsonOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

/** Map one `output[]` item to a {name, arguments} pair, or null if it isn't a tool call. */
function itemToCall(
  item: Record<string, unknown>,
  type: string
): { name?: string; arguments?: string } | null {
  switch (type) {
    case "function_call":
      return { name: strOf(item.name), arguments: strOf(item.arguments) };
    case "custom_tool_call":
      return { name: strOf(item.name), arguments: jsonOf(item.input) };
    case "local_shell_call":
    case "shell_call":
      // Codex's built-in shell tool: the command lives in `action`.
      return { name: "local_shell", arguments: jsonOf(item.action) };
    default:
      // Any other "*_call" kind we don't model explicitly: still govern it,
      // keyed by its type, with whatever payload field is present.
      if (type.endsWith("_call")) {
        return {
          name: type,
          arguments: jsonOf(item.action ?? item.input ?? item.arguments),
        };
      }
      return null;
  }
}

/**
 * Extract every tool call from a parsed Responses API response object.
 * @param onUnknownCall reports a "*_call" type that produced no usable name —
 *        signal that a new tool-call kind needs explicit handling.
 */
export function extractResponsesToolCalls(
  response: unknown,
  requestModel?: string,
  onUnknownCall?: (type: string) => void
): ObservedToolCall[] {
  const out: ObservedToolCall[] = [];
  if (typeof response !== "object" || response === null) return out;
  const r = response as Record<string, unknown>;
  const output = Array.isArray(r.output) ? r.output : [];
  const responseModel = strOf(r.model);
  const responseId = strOf(r.id);

  let ki = 0;
  for (const itemRaw of output) {
    if (typeof itemRaw !== "object" || itemRaw === null) continue;
    const item = itemRaw as Record<string, unknown>;
    const type = strOf(item.type) ?? "";
    const call = itemToCall(item, type);
    if (!call || call.name === undefined) {
      if (type.endsWith("_call")) onUnknownCall?.(type);
      continue;
    }

    const args = call.arguments;
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
      finish_reason: strOf(item.status),
      choice_index: 0,
      call_index: ki++,
      tool_call_id: strOf(item.call_id) ?? strOf(item.id),
      call_type: type,
      function_name: call.name,
      arguments: args,
      args_parse_ok: argsParseOk,
      args_bytes: args === undefined ? 0 : Buffer.byteLength(args, "utf8"),
    });
  }
  return out;
}

/**
 * Return the full Responses object from an upstream body, whether it came back
 * as a single JSON object (`stream:false`) or as an SSE event stream
 * (`stream:true`). For SSE we pull the `response` payload out of the terminal
 * `response.completed` event (falling back to the last event that carries a
 * complete `output[]`). Returns null if nothing parseable is found.
 */
export function parseResponsesBody(
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

  return parseSSEFinalResponse(bodyText);
}

/** True if a body/content-type is an SSE event stream rather than a JSON object. */
export function looksLikeSSE(bodyText: string, contentType?: string): boolean {
  return (
    (contentType ?? "").toLowerCase().includes("text/event-stream") ||
    /^\s*(event:|data:)/m.test(bodyText)
  );
}

function parseSSEFinalResponse(bodyText: string): Record<string, unknown> | null {
  // SSE: scan `data:` payloads; prefer response.completed, else last with output.
  let fallback: Record<string, unknown> | null = null;
  for (const line of bodyText.split(/\r?\n/)) {
    const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!trimmed || trimmed === "[DONE]") continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const inner = obj.response;
    if (obj.type === "response.completed" && inner && typeof inner === "object") {
      return inner as Record<string, unknown>;
    }
    if (inner && typeof inner === "object" && Array.isArray((inner as Record<string, unknown>).output)) {
      fallback = inner as Record<string, unknown>;
    } else if (Array.isArray(obj.output)) {
      fallback = obj;
    }
  }
  return fallback;
}

/**
 * Build a Responses-shaped denial from a held upstream body — the analog of
 * the chat path's `syntheticDenial`. It mirrors the held response's id / model
 * / usage but replaces `output[]` with a single assistant message and **no
 * tool calls**, so the agent sees "the model just spoke, nothing to run" and
 * proceeds without executing the withheld action.
 *
 * Returned in the same wire form the agent expects: a single JSON object if the
 * held response was JSON (`stream:false`), or a minimal valid SSE stream
 * (`response.created` → `response.completed`) if it was streamed.
 */
export function syntheticResponsesDenial(
  heldBody: string,
  contentType: string,
  reason: string
): { body: string; contentType: string } {
  const held = parseResponsesBody(heldBody, contentType) ?? {};
  const text =
    `Action withheld by Phinq governance (${reason}). ` +
    `The proposed tool call was not executed.`;

  const denial: Record<string, unknown> = {
    id: typeof held.id === "string" ? held.id : "phinq_denied",
    object: "response",
    created_at:
      typeof held.created_at === "number" ? held.created_at : Math.floor(Date.now() / 1000),
    model: held.model,
    status: "completed",
    output: [
      {
        id: "msg_phinq_denied",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: held.usage ?? null,
  };

  if (!looksLikeSSE(heldBody, contentType)) {
    return { body: JSON.stringify(denial), contentType: "application/json" };
  }

  const created = { ...denial, status: "in_progress", output: [] as unknown[] };
  const body =
    `data: ${JSON.stringify({ type: "response.created", response: created, sequence_number: 0 })}\n\n` +
    `data: ${JSON.stringify({ type: "response.completed", response: denial, sequence_number: 1 })}\n\n`;
  return { body, contentType: "text/event-stream" };
}
