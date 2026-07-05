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
 * upstream's own SSE: role delta first, then a delta carrying content and any
 * provider extras, then any tool_calls, then a terminal chunk carrying
 * finish_reason, then `[DONE]`. Standard OpenAI-compatible clients reassemble
 * it exactly as they would a real stream.
 */

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Everything on a chat message that belongs in a streamed delta but isn't
 * handled structurally (role, tool_calls): `content` plus provider-specific
 * fields the non-stream body may carry — `function_call` (legacy), `reasoning`
 * / `reasoning_content` (OpenRouter), `refusal`, `annotations`, `logprobs`.
 * Dropping these silently loses tokens the same request returns with
 * stream:false, so they ride through verbatim.
 */
function messageDelta(msg: Record<string, unknown>): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(msg)) {
    if (k === "role" || k === "tool_calls") continue; // emitted separately
    if (v === null || v === undefined) continue;
    if (k === "content" && v === "") continue; // empty content adds nothing
    delta[k] = v;
  }
  return delta;
}

/**
 * Convert a full chat.completion JSON body into an OpenAI-style SSE stream.
 * `includeUsage` gates the trailing usage-only chunk to clients that asked for
 * it (stream_options.include_usage); without it that chunk carries an empty
 * `choices` array that crashes clients which index choices[0] on every chunk.
 */
export function chatCompletionToSSE(
  body: Buffer | string,
  opts: { includeUsage?: boolean } = {}
): string {
  const text = typeof body === "string" ? body : body.toString("utf8");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON (a raw upstream error or gateway page). Preserve it verbatim as
    // one SSE event: prefix every physical line with `data:` so embedded
    // newlines don't break framing or inject spurious events.
    const payload = text
      .split(/\r?\n/)
      .map((line) => `data: ${line}`)
      .join("\n");
    return `${payload}\n\ndata: [DONE]\n\n`;
  }

  // Some OpenAI-compatible upstreams (OpenRouter) return provider failures as
  // HTTP 200 with an `{ error }` body and no choices. Surface it as an error
  // frame rather than fabricating a successful empty turn the client acts on.
  if (!Array.isArray(obj.choices) && obj.error !== undefined) {
    return `${frame({ error: obj.error })}data: [DONE]\n\n`;
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

    // One delta carrying content and any provider extras the buffered response
    // held, so the reconstruction loses nothing stream:false would have kept.
    const delta = messageDelta(msg);
    if (Object.keys(delta).length > 0) {
      frames.push(frame({ ...base, choices: [{ index: idx, delta, finish_reason: null }] }));
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

  // A trailing usage chunk (choices: []) is only part of the OpenAI streaming
  // contract when the client opted in via stream_options.include_usage.
  if (opts.includeUsage && obj.usage) {
    frames.push(frame({ ...base, choices: [], usage: obj.usage }));
  }

  frames.push("data: [DONE]\n\n");
  return frames.join("");
}
