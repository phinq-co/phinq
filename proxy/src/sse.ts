/**
 * Streaming bridge for the OpenAI Chat Completions dialect.
 *
 * Phinq has to see a *whole* response to do its job: it classifies the tool
 * calls in it, and when a HOLD fires it holds the entire action atomically.
 * A streamed response arrives token-by-token, which defeats both — you can't
 * classify or hold half an answer. So when a client asks for `stream: true`
 * we quietly ask the upstream for an ordinary (non-streamed) completion,
 * govern it in full, and then re-emit that final object to the client as
 * Server-Sent Events. The client sees ordinary streaming; governance sees the
 * whole picture. Approvals and denials stream out through the same path.
 *
 * This is a faithful-enough reconstruction, not a byte-for-byte replay of the
 * upstream's own SSE: role delta first, then content, then any tool_calls,
 * then a terminal chunk carrying finish_reason, then `[DONE]`. Standard
 * OpenAI-compatible clients reassemble it exactly as they would a real stream.
 */

/** Return a request body with streaming forced off (upstream must send full JSON). */
export function coerceNonStream(body: Buffer): Buffer {
  try {
    const obj = JSON.parse(body.toString("utf8"));
    if (obj && typeof obj === "object") {
      obj.stream = false;
      // include_usage only makes sense on a real stream; drop it so the
      // upstream returns a normal completion with a usage block.
      delete obj.stream_options;
      return Buffer.from(JSON.stringify(obj));
    }
  } catch {
    /* fall through: unparseable bodies forward unchanged */
  }
  return body;
}

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Convert a full chat.completion JSON body into an OpenAI-style SSE stream.
 * Non-JSON (e.g. an upstream error already shaped for the client) is emitted
 * as a single data frame so nothing is silently swallowed.
 */
export function chatCompletionToSSE(body: Buffer | string): string {
  const text = typeof body === "string" ? body : body.toString("utf8");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON (e.g. a raw upstream error) — pass the bytes through verbatim
    // in a single frame rather than silently dropping them.
    return `data: ${text}\n\ndata: [DONE]\n\n`;
  }

  const base = {
    id: (obj.id as string) ?? "chatcmpl-phinq",
    object: "chat.completion.chunk",
    created: (obj.created as number) ?? Math.floor(Date.now() / 1000),
    model: obj.model as string | undefined,
  };

  const frames: string[] = [];
  const choices = Array.isArray(obj.choices) ? (obj.choices as Record<string, unknown>[]) : [];

  for (const ch of choices) {
    const idx = (ch.index as number) ?? 0;
    const msg = (ch.message as Record<string, unknown>) ?? {};

    frames.push(frame({ ...base, choices: [{ index: idx, delta: { role: msg.role ?? "assistant" }, finish_reason: null }] }));

    if (typeof msg.content === "string" && msg.content.length > 0) {
      frames.push(frame({ ...base, choices: [{ index: idx, delta: { content: msg.content }, finish_reason: null }] }));
    }

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const tcs = (msg.tool_calls as Record<string, unknown>[]).map((tc, i) => {
        const fn = (tc.function as Record<string, unknown>) ?? {};
        return {
          index: i,
          id: tc.id,
          type: tc.type ?? "function",
          function: { name: fn.name, arguments: (fn.arguments as string) ?? "" },
        };
      });
      frames.push(frame({ ...base, choices: [{ index: idx, delta: { tool_calls: tcs }, finish_reason: null }] }));
    }

    frames.push(frame({ ...base, choices: [{ index: idx, delta: {}, finish_reason: ch.finish_reason ?? "stop" }] }));
  }

  if (choices.length === 0) {
    frames.push(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  }

  // A final usage-bearing chunk mirrors OpenAI's `stream_options.include_usage`.
  if (obj.usage) {
    frames.push(frame({ ...base, choices: [], usage: obj.usage }));
  }

  frames.push("data: [DONE]\n\n");
  return frames.join("");
}
