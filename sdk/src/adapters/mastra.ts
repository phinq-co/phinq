import type { PhinqGovernor, GateContext, GateResult } from "../governor.js";

/**
 * Mastra adapter. Wraps a tool's `execute` so every call is gated by Phinq at
 * the point of execution: ALLOW runs it, HOLD waits for the operator's verdict,
 * a block returns a denial message to the agent instead of running the tool.
 *
 * Structurally typed on purpose — the SDK does not depend on Mastra. Any object
 * with an `execute` function (and an `id`/`name`) is governable.
 */
export interface MastraToolLike {
  id?: string;
  name?: string;
  execute?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

export interface GovernToolOptions extends GateContext {
  /**
   * Build the value returned to the agent when a call is blocked. Defaults to a
   * short message so the model sees "this didn't run" and moves on.
   */
  onDenied?: (result: GateResult, call: { name: string; args: unknown }) => unknown;
}

/** Pull the validated tool input from Mastra's execute arguments. */
function extractInput(args: unknown[]): unknown {
  const first = args[0];
  if (first && typeof first === "object" && "context" in first) {
    return (first as { context: unknown }).context;
  }
  return first;
}

/** Return a copy of a Mastra tool whose execution is gated by Phinq. */
export function governTool<T extends MastraToolLike>(
  tool: T,
  governor: PhinqGovernor,
  options: GovernToolOptions = {}
): T {
  const original = tool.execute;
  if (typeof original !== "function") return tool;

  const name = tool.id ?? tool.name ?? "tool";
  const { onDenied, ...gateCtx } = options;

  const execute = async (...args: unknown[]): Promise<unknown> => {
    const input = extractInput(args);
    const result = await governor.gate({ name, args: input }, gateCtx);
    if (result.allowed) return (original as (...a: unknown[]) => unknown)(...args);
    return onDenied
      ? onDenied(result, { name, args: input })
      : `Action withheld by Phinq governance (${result.resolution}). ` +
          `The "${name}" call was not executed.`;
  };

  // Preserve the tool's prototype (Mastra tools can be class instances), copy
  // its own props, and override only `execute`.
  return Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, { execute });
}

/** Govern an entire Mastra toolset object (`{ [id]: tool }`) in one call. */
export function governTools<T extends Record<string, MastraToolLike>>(
  tools: T,
  governor: PhinqGovernor,
  options: GovernToolOptions = {}
): T {
  const out: Record<string, MastraToolLike> = {};
  for (const [key, tool] of Object.entries(tools)) {
    out[key] = governTool(tool, governor, options);
  }
  return out as T;
}
