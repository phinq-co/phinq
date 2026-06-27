#!/usr/bin/env node
/**
 * Phinq Day-0 measurement stub.
 *
 * Two modes:
 *
 *   --mode log     Transparent proxy to OpenRouter. Logs every request's
 *                  method, path, stream flag, model, and tool calls observed
 *                  in responses (JSONL to stdout + day0-observations.jsonl).
 *                  Auth headers pass through and are never logged.
 *
 *   --mode stall   Measures client patience. POST .../chat/completions with
 *                  stream:true  -> 400 "stream ... not supported" (exercises
 *                  Hermes's sticky non-streaming fallback, run_agent.py:7208).
 *                  stream:false -> never responds; logs when the client
 *                  gives up and closes the socket. That elapsed time is the
 *                  real hold-window bound.
 *
 * Zero dependencies. Usage:
 *   node stub.mjs --mode stall --port 5101
 *   node stub.mjs --mode log   --port 5101
 *
 * Point the agent at it:  base_url: http://127.0.0.1:5101/api/v1
 */
import http from "node:http";
import { appendFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) =>
    a.startsWith("--") ? [a.slice(2), all[i + 1] ?? "true"] : []
  ).filter((p) => p.length)
);
const MODE = args.mode ?? "log";
const PORT = Number(args.port ?? 5101);
const UPSTREAM = "https://openrouter.ai";
const OBS_FILE = new URL("./day0-observations.jsonl", import.meta.url).pathname;

function obs(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  console.log(line);
  appendFileSync(OBS_FILE, line + "\n");
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const body = await readBody(req);
  let parsed = null;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { /* not JSON */ }

  const isChat = req.method === "POST" && req.url.endsWith("/chat/completions");
  const streamFlag = parsed?.stream === true;

  if (MODE === "stall" && isChat) {
    if (streamFlag) {
      obs({ event: "stream_rejected", path: req.url, model: parsed?.model });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Streaming is not supported by this endpoint; retry with stream:false.",
          type: "invalid_request_error",
          code: "stream_not_supported",
        },
      }));
      return;
    }
    obs({ event: "stall_begin", path: req.url, model: parsed?.model });
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);
    res.on("close", () => {
      obs({
        event: "client_gave_up",
        path: req.url,
        model: parsed?.model,
        elapsed_seconds: Math.round((Date.now() - started) / 1000),
      });
    });
    return; // never respond — the measurement is when the client hangs up
  }

  if (MODE === "stall") {
    // Non-chat paths: answer minimally so startup checks don't block the test.
    obs({ event: "non_chat_request", method: req.method, path: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
    return;
  }

  // log mode: transparent passthrough to OpenRouter.
  const upstreamUrl = UPSTREAM + req.url;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    const respBuf = Buffer.from(await upstream.arrayBuffer());
    let toolCalls = [];
    try {
      const rj = JSON.parse(respBuf.toString("utf8"));
      toolCalls = (rj.choices ?? []).flatMap((c) =>
        (c.message?.tool_calls ?? []).map((t) => t.function?.name)
      );
    } catch { /* streaming or non-JSON */ }
    obs({
      event: "passthrough",
      method: req.method,
      path: req.url,
      stream: streamFlag,
      model: parsed?.model,
      status: upstream.status,
      latency_ms: Date.now() - started,
      tool_calls: toolCalls,
    });
    const respHeaders = Object.fromEntries(upstream.headers.entries());
    delete respHeaders["content-encoding"];
    delete respHeaders["content-length"];
    delete respHeaders["transfer-encoding"];
    res.writeHead(upstream.status, respHeaders);
    res.end(respBuf);
  } catch (err) {
    obs({ event: "upstream_error", path: req.url, error: String(err) });
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream unreachable: " + err } }));
  }
});

server.headersTimeout = 0;
server.requestTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 0;
server.listen(PORT, () => {
  console.log(`# phinq day-0 stub | mode=${MODE} | http://127.0.0.1:${PORT}/api/v1`);
  console.log(`# observations -> ${OBS_FILE}`);
});
