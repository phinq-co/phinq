import type { ProxyConfig } from "./config.js";

/** Headers that must not be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers the proxy owns or that would corrupt the forward. */
const REQUEST_STRIP = new Set([
  ...HOP_BY_HOP,
  "host",
  "content-length",
  // undici negotiates its own compression and decodes transparently.
  "accept-encoding",
  "expect",
]);

/** Response headers invalidated by transparent decompression / re-framing. */
const RESPONSE_STRIP = new Set([
  ...HOP_BY_HOP,
  "content-encoding",
  "content-length",
]);

export interface UpstreamResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ForwardRequest {
  method: string;
  /** Path + query, already normalized to start with /api/v1/. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

/**
 * Forward a request to the upstream verbatim (minus hop-by-hop headers)
 * and return the raw response. The caller decides what to do with it —
 * this function never modifies bodies.
 */
export async function forwardToUpstream(
  req: ForwardRequest,
  config: ProxyConfig,
  upstreamOverride?: string
): Promise<UpstreamResult> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || REQUEST_STRIP.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }

  const origin = upstreamOverride ?? config.upstream;
  const hasBody = req.body !== undefined && !["GET", "HEAD"].includes(req.method);
  const response = await fetch(origin + req.path, {
    method: req.method,
    headers,
    body: hasBody ? new Uint8Array(req.body!) : undefined,
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    redirect: "manual",
  });

  const body = Buffer.from(await response.arrayBuffer());
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!RESPONSE_STRIP.has(name.toLowerCase())) responseHeaders[name] = value;
  });

  return { status: response.status, headers: responseHeaders, body };
}
