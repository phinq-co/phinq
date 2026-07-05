import type { ObservedToolCall } from "./toolcalls.js";
import { looksLikeSSE } from "./responses.js";

/**
 * Google Gemini `generateContent` governance — the fourth dialect, after
 * chat-completions, Responses, and Anthropic Messages. Covers the Gemini CLI,
 * the google-genai SDKs, and Google ADK agents.
 *
 * Wire differences handled here:
 *  - The model lives in the URL (`/v1beta/models/<model>:generateContent`),
 *    not the request body.
 *  - Tool calls are `functionCall` parts inside
 *    `candidates[].content.parts[]`, with a structured `args` object.
 *  - `:streamGenerateContent` has TWO stream encodings: a JSON *array* of
 *    chunk objects (the default) and SSE (`?alt=sse`). Both are replayed into
 *    one complete response so the classifier sees whole actions.
 *  - Usage is `usageMetadata` (promptTokenCount / candidatesTokenCount /
 *    totalTokenCount) — mapped by the shared fuel gauge in server.ts.
 *
 * Read-only and fail-open: any odd shape yields [] / null rather than throwing.
 */

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The three wire forms a Gemini body can arrive in. */
export type GeminiWireForm = "json" | "array" | "sse";

export function geminiWireForm(bodyText: string, contentType?: string): GeminiWireForm {
  if (looksLikeSSE(bodyText, contentType)) return "sse";
  return bodyText.trimStart().startsWith("[") ? "array" : "json";
}

/** Extract every functionCall part from a parsed GenerateContentResponse. */
export function extractGeminiToolCalls(
  response: unknown,
  requestModel?: string
): ObservedToolCall[] {
  const out: ObservedToolCall[] = [];
  if (typeof response !== "object" || response === null) return out;
  const r = response as Record<string, unknown>;
  const candidates = Array.isArray(r.candidates) ? r.candidates : [];
  const responseModel = strOf(r.modelVersion) ?? requestModel;
  const responseId = strOf(r.responseId);

  for (let ci = 0; ci < candidates.length; ci++) {
    const cand = candidates[ci];
    if (typeof cand !== "object" || cand === null) continue;
    const c = cand as Record<string, unknown>;
    const content = c.content as Record<string, unknown> | undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    const finishReason = strOf(c.finishReason);

    let ki = 0;
    for (const partRaw of parts) {
      if (typeof partRaw !== "object" || partRaw === null) continue;
      const fc = (partRaw as Record<string, unknown>).functionCall;
      if (typeof fc !== "object" || fc === null) continue;
      const f = fc as Record<string, unknown>;
      const name = strOf(f.name);
      if (name === undefined) continue;

      // Gemini `args` is a structured object; serialize for the classifier.
      let args: string | undefined;
      try {
        args = f.args === undefined ? undefined : JSON.stringify(f.args);
      } catch {
        args = undefined;
      }
      // `args` is either undefined or the output of a successful JSON.stringify,
      // which always round-trips — so parse-ok is exactly "did we serialize it".
      const argsParseOk = args !== undefined;

      out.push({
        ts: new Date().toISOString(),
        event: "tool_call",
        request_model: requestModel,
        response_model: responseModel,
        response_id: responseId,
        finish_reason: finishReason,
        choice_index: ci,
        call_index: ki++,
        tool_call_id: strOf(f.id),
        call_type: "functionCall",
        function_name: name,
        arguments: args,
        args_parse_ok: argsParseOk,
        args_bytes: args === undefined ? 0 : Buffer.byteLength(args, "utf8"),
      });
    }
  }
  return out;
}

/**
 * Return one complete GenerateContentResponse from an upstream body, whatever
 * wire form it arrived in: a single JSON object, a JSON array of streamed
 * chunks, or SSE. Streamed chunks are merged — parts accumulate per candidate
 * index, the last finishReason/usageMetadata win. Returns null when nothing
 * parseable is found.
 */
export function parseGeminiBody(
  bodyText: string,
  contentType?: string
): Record<string, unknown> | null {
  const form = geminiWireForm(bodyText, contentType);
  if (form === "json") {
    try {
      return JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  let chunks: unknown[] = [];
  if (form === "array") {
    try {
      const parsed = JSON.parse(bodyText);
      if (Array.isArray(parsed)) chunks = parsed;
    } catch {
      return null;
    }
  } else {
    for (const line of bodyText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        chunks.push(JSON.parse(payload));
      } catch {
        /* skip malformed frames */
      }
    }
  }
  return mergeGeminiChunks(chunks);
}

function mergeGeminiChunks(chunks: unknown[]): Record<string, unknown> | null {
  if (chunks.length === 0) return null;
  const merged: Record<string, unknown> = {};
  // candidate index → accumulated parts + latest candidate fields
  const parts: Record<number, unknown[]> = {};
  const candMeta: Record<number, Record<string, unknown>> = {};

  for (const chunkRaw of chunks) {
    if (typeof chunkRaw !== "object" || chunkRaw === null) continue;
    const chunk = chunkRaw as Record<string, unknown>;
    if (merged.responseId === undefined && chunk.responseId !== undefined)
      merged.responseId = chunk.responseId;
    if (merged.modelVersion === undefined && chunk.modelVersion !== undefined)
      merged.modelVersion = chunk.modelVersion;
    if (chunk.usageMetadata !== undefined) merged.usageMetadata = chunk.usageMetadata;

    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      if (typeof cand !== "object" || cand === null) continue;
      const c = cand as Record<string, unknown>;
      const index = typeof c.index === "number" ? c.index : i;
      const meta = (candMeta[index] ??= {});
      if (c.finishReason !== undefined) meta.finishReason = c.finishReason;
      const content = c.content as Record<string, unknown> | undefined;
      if (content) {
        if (content.role !== undefined) meta.role = content.role;
        if (Array.isArray(content.parts)) (parts[index] ??= []).push(...content.parts);
      }
    }
  }

  merged.candidates = Object.keys(candMeta)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => ({
      content: { role: candMeta[index].role ?? "model", parts: parts[index] ?? [] },
      finishReason: candMeta[index].finishReason,
      index,
    }));
  return merged;
}

/**
 * Build a Gemini-shaped denial from a held body — a single text part, no
 * functionCall, finishReason STOP — returned in the held body's wire form.
 */
export function syntheticGeminiDenial(
  heldBody: string,
  contentType: string,
  reason: string
): { body: string; contentType: string } {
  const form = geminiWireForm(heldBody, contentType);
  const held = parseGeminiBody(heldBody, contentType) ?? {};
  const text =
    `Action withheld by Phinq governance (${reason}). ` +
    `The proposed tool call was not executed.`;

  const denial: Record<string, unknown> = {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: held.usageMetadata ?? {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    },
  };
  if (held.modelVersion !== undefined) denial.modelVersion = held.modelVersion;
  if (held.responseId !== undefined) denial.responseId = held.responseId;

  switch (form) {
    case "sse":
      return { body: `data: ${JSON.stringify(denial)}\n\n`, contentType: "text/event-stream" };
    case "array":
      return { body: JSON.stringify([denial]), contentType: "application/json" };
    default:
      return { body: JSON.stringify(denial), contentType: "application/json" };
  }
}

/** Pull the model out of a Gemini URL: /v1beta/models/<model>:generateContent */
export function geminiModelFromUrl(url: string): string | undefined {
  const m = url.match(/\/models\/([^:/?]+):/);
  return m?.[1];
}

/**
 * True for a Gemini generateContent / streamGenerateContent request path, on
 * ANY API version prefix (/v1beta, /v1alpha, and the /v1 a google-genai client
 * pinned to `api_version='v1'` uses). The colon-verb is unique to Gemini — no
 * OpenAI/OpenRouter route carries one — so it safely distinguishes a Gemini
 * call that landed on a version prefix shared with other dialects.
 */
export function isGeminiGenerateContent(url: string): boolean {
  return /:(stream)?generatecontent/i.test(url.split("?")[0]);
}
