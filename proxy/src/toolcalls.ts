import { appendFile } from "node:fs/promises";

/**
 * Component 2 — tool call inspection (PROXY-MVP.md, day 3–4).
 *
 * Parses `choices[].message.tool_calls` out of upstream chat-completion
 * responses and records one JSONL line per observed call. No classification
 * yet: the output of running real traffic through this for a day IS the
 * corpus that calibrates the component-3 classifier.
 *
 * Inspection is strictly read-only and fail-open: any error here must never
 * alter, delay, or block the relayed response.
 */

export interface ObservedToolCall {
  ts: string;
  event: "tool_call";
  /** Model the client asked for (request body). */
  request_model?: string;
  /** Model that actually answered (response body) — OpenRouter may differ. */
  response_model?: string;
  response_id?: string;
  finish_reason?: string;
  choice_index: number;
  call_index: number;
  tool_call_id?: string;
  /** tool_calls[].type — "function" today, but recorded in case new kinds appear. */
  call_type?: string;
  function_name?: string;
  /** Raw arguments JSON string, exactly as the model produced it. */
  arguments?: string;
  /** Whether `arguments` parsed as JSON. Models do emit broken JSON; that's signal. */
  args_parse_ok: boolean;
  args_bytes: number;
  /** Component 3 shadow classification — present once the classifier runs. */
  action_class?: string;
  decision?: "ALLOW" | "HOLD";
  triggers?: string[];
  reasons?: string[];
  unknown_tool?: boolean;
}

/**
 * Extract every tool call from a parsed chat-completion response body.
 * Defensive against missing/odd shapes: returns [] rather than throwing.
 */
export function extractToolCalls(
  response: unknown,
  requestModel?: string
): ObservedToolCall[] {
  const out: ObservedToolCall[] = [];
  if (typeof response !== "object" || response === null) return out;
  const r = response as Record<string, unknown>;
  const choices = Array.isArray(r.choices) ? r.choices : [];

  for (let ci = 0; ci < choices.length; ci++) {
    const choice = choices[ci] as Record<string, unknown> | null;
    const message = choice?.message as Record<string, unknown> | undefined;
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

    for (let ki = 0; ki < calls.length; ki++) {
      const call = calls[ki] as Record<string, unknown> | null;
      const fn = call?.function as Record<string, unknown> | undefined;
      const args = typeof fn?.arguments === "string" ? fn.arguments : undefined;

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
        response_model: typeof r.model === "string" ? r.model : undefined,
        response_id: typeof r.id === "string" ? r.id : undefined,
        finish_reason:
          typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
        choice_index: ci,
        call_index: ki,
        tool_call_id: typeof call?.id === "string" ? call.id : undefined,
        call_type: typeof call?.type === "string" ? call.type : undefined,
        function_name: typeof fn?.name === "string" ? fn.name : undefined,
        arguments: args,
        args_parse_ok: argsParseOk,
        args_bytes: args === undefined ? 0 : Buffer.byteLength(args, "utf8"),
      });
    }
  }
  return out;
}

/**
 * Appends observed tool calls to a JSONL corpus file. Writes are serialized
 * through a promise chain so concurrent responses can't interleave lines,
 * and failures are reported once via the supplied logger — never thrown.
 */
export class ToolCallCorpus {
  private tail: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(
    private readonly path: string,
    private readonly logError: (msg: string) => void
  ) {}

  record(calls: ObservedToolCall[]): void {
    if (calls.length === 0) return;
    const lines = calls.map((c) => JSON.stringify(c)).join("\n") + "\n";
    this.tail = this.tail
      .then(() => appendFile(this.path, lines, "utf8"))
      .catch((err) => {
        if (!this.warned) {
          this.warned = true;
          this.logError(`tool-call corpus write failed (${this.path}): ${String(err)}`);
        }
      });
  }

  /** Wait for pending writes — used by tests and graceful shutdown. */
  flush(): Promise<void> {
    return this.tail;
  }
}
