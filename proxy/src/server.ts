import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ProxyConfig } from "./config.js";
import { forwardToUpstream, type UpstreamResult } from "./upstream.js";
import { extractToolCalls, ToolCallCorpus, type ObservedToolCall } from "./toolcalls.js";
import {
  extractResponsesToolCalls,
  parseResponsesBody,
  syntheticResponsesDenial,
} from "./responses.js";
import {
  extractMessagesToolCalls,
  parseMessagesBody,
  syntheticMessagesDenial,
} from "./anthropic.js";
import { classifyToolCall, sessionEventKind } from "./classifier.js";
import { SessionStore, sessionKeyFromAuth } from "./session.js";
import { loadPhinqRules, type PhinqRulesConfig } from "./phinq-config.js";
import { HoldStore, syntheticDenial } from "./holds.js";
import { TelegramNotifier } from "./telegram.js";
import { AuditLog } from "./audit.js";
import { timingSafeEqual } from "node:crypto";

export const VERSION = "0.8.0";

/**
 * Exact shape required to trigger Hermes's sticky non-streaming fallback:
 * the message must contain "stream" and "not supported" (case-insensitive).
 * See DAY0-FINDINGS.md §1 / hermes run_agent.py:7207. Do not reword.
 */
const STREAM_NOT_SUPPORTED = {
  error: {
    message: "Streaming is not supported by this endpoint; retry with stream:false.",
    type: "invalid_request_error",
    code: "stream_not_supported",
  },
};

interface Governance {
  rules: PhinqRulesConfig["rules"];
  sessions: SessionStore;
  /** Set when enforcement is active (component 4); null = shadow mode. */
  holds: HoldStore | null;
  notifier: TelegramNotifier | null;
  holdTimeoutMs: number;
  /** Hash-chained audit log (component 5); null = disabled. */
  audit: AuditLog | null;
  enforcing: boolean;
}

export function buildServer(config: ProxyConfig): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.PHINQ_LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers['x-api-key']"],
    },
    // The proxy must never re-serialize client bodies: capture raw bytes,
    // parse a copy only for inspection, forward the original buffer.
    bodyLimit: 50 * 1024 * 1024,
  });

  const corpus = config.toolCallLogPath
    ? new ToolCallCorpus(config.toolCallLogPath, (msg) => app.log.error(msg))
    : null;

  // Component 3 — deterministic classifier (always on).
  const phinq = loadPhinqRules(config.phinqConfigPath, (msg) => app.log.warn(msg));
  const sessions = new SessionStore(config.sessionDbPath, phinq.windows);

  // Component 4 — enforcement. env vars win over phinq.yaml.
  const enforceRequested = config.enforce || phinq.hold.enforce === true;
  const holdTimeoutSeconds = phinq.hold.timeoutSeconds ?? config.holdTimeoutSeconds;
  const telegramChatId = config.telegramChatId ?? phinq.telegram.operatorChatId;
  const telegramReady = Boolean(config.telegramBotToken && telegramChatId);

  if (holdTimeoutSeconds > 240) {
    app.log.warn(
      { hold_timeout_seconds: holdTimeoutSeconds },
      "hold timeout exceeds 240s — stock Hermes kills non-streaming connections at 300s; " +
        "set providers.openrouter.stale_timeout_seconds in the agent config (see README)"
    );
  }
  // Enforcement no longer requires Telegram: holds can always be approved
  // locally via the control API + `phinq` CLI. Telegram is an optional
  // outbound alert (it works even where its inbound callbacks don't).
  const enforcing = enforceRequested;
  if (enforcing && !telegramReady) {
    app.log.info(
      {},
      "enforcement on without Telegram — approve holds locally with `phinq approve <id>` " +
        "(or set PHINQ_TELEGRAM_* for phone alerts)"
    );
  }

  // Component 5 — hash-chained audit log (always on unless disabled).
  const audit = config.auditLogPath
    ? new AuditLog(config.auditLogPath, (msg) => app.log.error(msg))
    : null;

  let holds: HoldStore | null = null;
  let notifier: TelegramNotifier | null = null;
  if (enforcing) {
    holds = new HoldStore(config.holdDbPath, app.log);
    holds.installSecret(); // generate + persist now so the `phinq` CLI can auth
    holds.addTransitionListener((hold) => {
      audit?.append({
        type: "hold_transition",
        ts: new Date().toISOString(),
        hold_id: hold.id,
        status: hold.status,
        decided_by: hold.decided_by,
      });
    });
    if (telegramReady) {
      notifier = new TelegramNotifier(
        {
          botToken: config.telegramBotToken!,
          operatorChatId: telegramChatId!,
          apiBase: config.telegramApiBase,
        },
        holds,
        app.log
      );
      app.addHook("onReady", async () => notifier!.start());
    }
    app.log.info(
      { hold_timeout_seconds: holdTimeoutSeconds, telegram: telegramReady, local_approval: true },
      "ENFORCEMENT ACTIVE — holds enabled"
    );
  } else {
    app.log.info({}, "shadow mode — decisions logged, nothing held");
  }

  const governance: Governance = {
    rules: phinq.rules,
    sessions,
    holds,
    notifier,
    holdTimeoutMs: holdTimeoutSeconds * 1000,
    audit,
    enforcing,
  };

  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, payload, done) => {
    done(null, payload);
  });

  app.addHook("onClose", async () => {
    notifier?.stop();
    holds?.close();
    await corpus?.flush();
    await audit?.flush();
    sessions.close();
  });

  app.get("/healthz", async () => ({
    ok: true,
    service: "phinq-proxy",
    version: VERSION,
    upstream: config.upstream,
    mode: enforcing ? "enforce" : "shadow",
  }));

  // ---- Local approval control API (the `phinq` CLI talks to these) --------
  // Authenticated by the per-install secret stored in the hold DB, which only
  // a process with filesystem access to that DB can read — same trust boundary
  // as the operator's shell. Bind stays localhost by default.
  const requireAuth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!holds) {
      reply.code(409).send({ error: { message: "proxy is in shadow mode; no holds", code: "not_enforcing" } });
      return false;
    }
    const expected = `Bearer ${holds.installSecret()}`;
    const got = req.headers.authorization ?? "";
    if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      reply.code(401).send({ error: { message: "bad or missing control token", code: "unauthorized" } });
      return false;
    }
    return true;
  };

  app.get("/phinq/holds", (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const now = Date.now();
    reply.send({
      holds: holds!.listPending().map((h) => ({
        id: h.id,
        age_seconds: Math.round((now - h.created_at) / 1000),
        expires_in_seconds: Math.max(0, Math.round((h.timeout_at - now) / 1000)),
        model: h.model,
        calls: h.calls.map((c) => ({
          function_name: c.function_name,
          action_class: c.action_class,
          triggers: c.triggers ?? [],
          arguments: c.arguments,
        })),
      })),
    });
  });

  for (const decision of ["approve", "deny"] as const) {
    app.post(`/phinq/holds/:id/${decision}`, (req, reply) => {
      if (!requireAuth(req, reply)) return;
      const { id } = req.params as { id: string };
      const result = holds!.decide(id, decision, "local:cli");
      reply.send(result);
    });
  }

  // Governed path — both prefixes Hermes-style base URLs can produce.
  for (const path of ["/v1/chat/completions", "/api/v1/chat/completions"]) {
    app.post(path, (req, reply) =>
      governedChatCompletions(req, reply, config, corpus, governance)
    );
  }

  // Responses API governed path (Codex `wire_api=responses`, and any other
  // Responses-based agent). Registered before the /v1/* blind catch-all so
  // these specific routes win. Shadow inspection today (observe + classify +
  // log); enforcement on this path is a follow-up.
  for (const path of ["/v1/responses", "/api/v1/responses"]) {
    app.post(path, (req, reply) =>
      governedResponses(req, reply, config, corpus, governance)
    );
  }

  // Anthropic Messages API governed path (the Anthropic SDK and Claude-native
  // agents). Forwards to the Anthropic upstream, not OpenRouter.
  app.post("/v1/messages", (req, reply) =>
    governedMessages(req, reply, config, corpus, governance)
  );

  // Everything else under /v1 and /api/v1 blind-proxies upstream.
  app.all("/v1/*", (req, reply) => blindPassthrough(req, reply, config));
  app.all("/api/v1/*", (req, reply) => blindPassthrough(req, reply, config));

  // Test access to the enforcement internals (pressing Telegram buttons).
  app.decorate("phinq", { holds, notifier });

  return app;
}

/** Map an incoming URL to the upstream path: /v1/x and /api/v1/x → /api/v1/x. */
export function normalizeUpstreamPath(url: string): string {
  return url.startsWith("/api/v1/") ? url : "/api" + url;
}

async function governedChatCompletions(
  req: FastifyRequest,
  reply: FastifyReply,
  config: ProxyConfig,
  corpus: ToolCallCorpus | null,
  governance: Governance
): Promise<void> {
  const body = req.body as Buffer | undefined;
  const started = Date.now();

  // Parse a copy for inspection only. Unparseable bodies forward verbatim —
  // the upstream is the authority on rejecting malformed requests.
  let parsed: Record<string, unknown> | null = null;
  if (body) {
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      parsed = null;
    }
  }

  if (parsed?.stream === true) {
    req.log.info({ model: parsed.model, path: req.url }, "stream request rejected");
    reply.code(400).send(STREAM_NOT_SUPPORTED);
    return;
  }

  const requestModel = typeof parsed?.model === "string" ? parsed.model : undefined;

  const result = await forwardOrFail(req, reply, config, { model: requestModel, started });
  if (!result) return; // error response already sent

  const sessionKey = sessionKeyFromAuth(req.headers.authorization);

  if (result.status !== 200) {
    // Upstream errors feed the AFTER_ERROR_BULK window, then pass through.
    try {
      governance.sessions.record(sessionKey, "error");
    } catch {
      /* session bookkeeping is fail-open */
    }
    reply.code(result.status).headers(result.headers).send(result.body);
    return;
  }

  // Components 2+3: inspection + classification. Fail-open: any error here
  // must never block the relayed response.
  let calls: ObservedToolCall[] = [];
  try {
    const response = JSON.parse(result.body.toString("utf8"));
    calls = extractToolCalls(response, requestModel);
    if (calls.length > 0) {
      // Counts are read once and incremented in-memory so multiple calls in
      // one response accumulate correctly.
      const counts = governance.sessions.counts(sessionKey);
      for (const call of calls) {
        const c = classifyToolCall(
          { name: call.function_name, argumentsJson: call.arguments },
          counts,
          governance.rules
        );
        call.action_class = c.action_class;
        call.decision = c.decision;
        call.triggers = c.triggers;
        call.reasons = c.reasons;
        call.unknown_tool = c.unknown_tool;

        const kind = sessionEventKind(call.function_name);
        if (kind) {
          governance.sessions.record(sessionKey, kind);
          if (kind === "send") counts.sends += 1;
          else counts.deletes += 1;
        }
      }

      corpus?.record(calls);
      req.log.info(
        {
          response_id: calls[0].response_id,
          model: calls[0].response_model ?? requestModel,
          tool_calls: calls.map((c) => c.function_name),
          decisions: calls.map((c) => c.decision),
          held: calls.filter((c) => c.decision === "HOLD").map((c) => c.function_name),
        },
        "tool calls observed"
      );
    }
  } catch (err) {
    req.log.warn({ err: String(err) }, "tool-call inspection skipped");
  }

  // Component 4: any HOLD holds the entire response atomically (spec #3).
  // The hold store is what enforces; the Telegram notifier is an optional
  // alert (holds are equally resolvable via the local `phinq` CLI).
  const anyHold = calls.some((c) => c.decision === "HOLD");
  const willHold = anyHold && governance.holds !== null;

  // Component 5: one audit entry per classified call. Arguments stay in the
  // corpus; the chain records intent + classification, not payloads.
  const auditDecisions = (holdId?: string) => {
    for (const call of calls) {
      governance.audit?.append({
        type: "decision",
        ts: new Date().toISOString(),
        response_id: call.response_id,
        model: call.response_model ?? requestModel,
        function_name: call.function_name,
        action_class: call.action_class,
        triggers: call.triggers,
        decision: call.decision,
        enforced: governance.enforcing,
        hold_id: call.decision === "HOLD" ? holdId : undefined,
        args_bytes: call.args_bytes,
      });
    }
  };

  if (willHold) {
    const heldCalls = calls; // all calls shown to the operator, one decision
    const responseId = calls[0]?.response_id;
    const { id, outcome } = governance.holds!.createAndWait({
      responseBody: result.body,
      calls: heldCalls,
      timeoutMs: governance.holdTimeoutMs,
      model: calls[0]?.response_model ?? requestModel,
      responseId,
    });
    auditDecisions(id);
    governance.audit?.append({
      type: "hold_transition",
      ts: new Date().toISOString(),
      hold_id: id,
      status: "PENDING",
    });

    // If the agent hangs up while we wait, the action must not execute.
    req.raw.once("close", () => governance.holds?.clientClosed(id));

    const hold = governance.holds!.get(id);
    if (hold) {
      void governance.notifier?.notifyHold(hold, governance.holdTimeoutMs / 1000);
      req.log.info(
        { hold_id: id, approve: `phinq approve ${id}`, deny: `phinq deny ${id}` },
        "awaiting operator decision"
      );
    }

    const decision = await outcome;
    req.log.info({ hold_id: id, outcome: decision, latency_ms: Date.now() - started }, "hold completed");

    switch (decision) {
      case "APPROVED":
        reply.code(result.status).headers(result.headers).send(result.body);
        return;
      case "DENIED":
        reply.code(200).header("content-type", "application/json").send(syntheticDenial(result.body, "denied"));
        return;
      case "EXPIRED_TIMEOUT":
        reply.code(200).header("content-type", "application/json").send(syntheticDenial(result.body, "timeout"));
        return;
      case "EXPIRED_CLIENT":
        // Connection is (almost certainly) gone — a best-effort denial is a
        // no-op on a dead socket, and saves the agent if it is somehow alive.
        reply.code(200).header("content-type", "application/json").send(syntheticDenial(result.body, "timeout"));
        return;
    }
  }

  if (calls.length > 0) auditDecisions();
  reply.code(result.status).headers(result.headers).send(result.body);
}

/**
 * Governed handler for the OpenAI Responses API (`/responses`). Tool calls
 * live in the response's top-level `output[]` (see responses.ts) instead of
 * `choices[].message.tool_calls`. Inspection is shadow-only: classify, record
 * to the corpus + audit chain, relay the original bytes unchanged. Holding on
 * this path (synthesizing a Responses-shaped denial, incl. SSE) is a follow-up;
 * until then a HOLD verdict is logged as would-hold and passed through.
 */
async function governedResponses(
  req: FastifyRequest,
  reply: FastifyReply,
  config: ProxyConfig,
  corpus: ToolCallCorpus | null,
  governance: Governance
): Promise<void> {
  const body = req.body as Buffer | undefined;
  const started = Date.now();

  let parsedReq: Record<string, unknown> | null = null;
  if (body) {
    try {
      parsedReq = JSON.parse(body.toString("utf8"));
    } catch {
      parsedReq = null;
    }
  }
  const requestModel = typeof parsedReq?.model === "string" ? parsedReq.model : undefined;

  const result = await forwardOrFail(req, reply, config, { model: requestModel, started });
  if (!result) return;

  const sessionKey = sessionKeyFromAuth(req.headers.authorization);

  if (result.status !== 200) {
    try {
      governance.sessions.record(sessionKey, "error");
    } catch {
      /* session bookkeeping is fail-open */
    }
    reply.code(result.status).headers(result.headers).send(result.body);
    return;
  }

  // Inspect + classify (shadow). Fail-open: never block the relayed response.
  let calls: ObservedToolCall[] = [];
  try {
    const ct = String(result.headers["content-type"] ?? "");
    const responseObj = parseResponsesBody(result.body.toString("utf8"), ct);
    calls = extractResponsesToolCalls(responseObj, requestModel, (t) =>
      req.log.warn({ output_item_type: t }, "unmodeled responses tool-call type")
    );
    if (calls.length > 0) {
      const counts = governance.sessions.counts(sessionKey);
      for (const call of calls) {
        const c = classifyToolCall(
          { name: call.function_name, argumentsJson: call.arguments },
          counts,
          governance.rules
        );
        call.action_class = c.action_class;
        call.decision = c.decision;
        call.triggers = c.triggers;
        call.reasons = c.reasons;
        call.unknown_tool = c.unknown_tool;

        const kind = sessionEventKind(call.function_name);
        if (kind) {
          governance.sessions.record(sessionKey, kind);
          if (kind === "send") counts.sends += 1;
          else counts.deletes += 1;
        }
      }

      corpus?.record(calls);
      req.log.info(
        {
          api: "responses",
          response_id: calls[0].response_id,
          model: calls[0].response_model ?? requestModel,
          tool_calls: calls.map((c) => c.function_name),
          decisions: calls.map((c) => c.decision),
          held: calls.filter((c) => c.decision === "HOLD").map((c) => c.function_name),
        },
        "tool calls observed"
      );
    }
  } catch (err) {
    req.log.warn({ err: String(err) }, "responses inspection skipped");
  }

  // One audit entry per classified call; reused for both hold and pass-through.
  const auditDecisions = (holdId?: string) => {
    for (const call of calls) {
      governance.audit?.append({
        type: "decision",
        ts: new Date().toISOString(),
        response_id: call.response_id,
        model: call.response_model ?? requestModel,
        function_name: call.function_name,
        action_class: call.action_class,
        triggers: call.triggers,
        decision: call.decision,
        enforced: governance.enforcing,
        hold_id: call.decision === "HOLD" ? holdId : undefined,
        args_bytes: call.args_bytes,
      });
    }
  };

  // Enforcement: any HOLD holds the whole response until the operator decides.
  const anyHold = calls.some((c) => c.decision === "HOLD");
  const willHold = anyHold && governance.holds !== null;

  if (willHold) {
    const ct = String(result.headers["content-type"] ?? "");
    const { id, outcome } = governance.holds!.createAndWait({
      responseBody: result.body,
      calls,
      timeoutMs: governance.holdTimeoutMs,
      model: calls[0]?.response_model ?? requestModel,
      responseId: calls[0]?.response_id,
    });
    auditDecisions(id);
    governance.audit?.append({
      type: "hold_transition",
      ts: new Date().toISOString(),
      hold_id: id,
      status: "PENDING",
    });

    // If the agent hangs up while we wait, the action must not execute.
    req.raw.once("close", () => governance.holds?.clientClosed(id));

    const hold = governance.holds!.get(id);
    if (hold) {
      void governance.notifier?.notifyHold(hold, governance.holdTimeoutMs / 1000);
      req.log.info(
        { hold_id: id, api: "responses", approve: `phinq approve ${id}`, deny: `phinq deny ${id}` },
        "awaiting operator decision"
      );
    }

    const decision = await outcome;
    req.log.info(
      { hold_id: id, outcome: decision, latency_ms: Date.now() - started },
      "hold completed"
    );

    if (decision === "APPROVED") {
      reply.code(result.status).headers(result.headers).send(result.body);
      return;
    }
    // DENIED / EXPIRED_TIMEOUT / EXPIRED_CLIENT → Responses-shaped denial so the
    // agent sees a message with no tool call and does not execute the action.
    const reason = decision === "DENIED" ? "denied" : "timeout";
    const denial = syntheticResponsesDenial(result.body.toString("utf8"), ct, reason);
    reply.code(200).header("content-type", denial.contentType).send(denial.body);
    return;
  }

  if (calls.length > 0) auditDecisions();
  reply.code(result.status).headers(result.headers).send(result.body);
}

async function governedMessages(
  req: FastifyRequest,
  reply: FastifyReply,
  config: ProxyConfig,
  corpus: ToolCallCorpus | null,
  governance: Governance
): Promise<void> {
  const body = req.body as Buffer | undefined;
  const started = Date.now();

  let parsedReq: Record<string, unknown> | null = null;
  if (body) {
    try {
      parsedReq = JSON.parse(body.toString("utf8"));
    } catch {
      parsedReq = null;
    }
  }
  const requestModel = typeof parsedReq?.model === "string" ? parsedReq.model : undefined;

  // Anthropic Messages forwards to the Anthropic upstream with the path
  // preserved (real endpoint is /v1/messages, not /api/v1/...).
  const result = await forwardOrFail(
    req,
    reply,
    config,
    { model: requestModel, started },
    { upstream: config.anthropicUpstream, path: req.url }
  );
  if (!result) return;

  // Anthropic authenticates with x-api-key, not Bearer; key the session off it.
  const authHeader =
    (req.headers["x-api-key"] as string | undefined) ?? req.headers.authorization;
  const sessionKey = sessionKeyFromAuth(authHeader);

  if (result.status !== 200) {
    try {
      governance.sessions.record(sessionKey, "error");
    } catch {
      /* session bookkeeping is fail-open */
    }
    reply.code(result.status).headers(result.headers).send(result.body);
    return;
  }

  // Inspect + classify. Fail-open: never block the relayed response.
  let calls: ObservedToolCall[] = [];
  try {
    const ct = String(result.headers["content-type"] ?? "");
    const message = parseMessagesBody(result.body.toString("utf8"), ct);
    calls = extractMessagesToolCalls(message, requestModel);
    if (calls.length > 0) {
      const counts = governance.sessions.counts(sessionKey);
      for (const call of calls) {
        const c = classifyToolCall(
          { name: call.function_name, argumentsJson: call.arguments },
          counts,
          governance.rules
        );
        call.action_class = c.action_class;
        call.decision = c.decision;
        call.triggers = c.triggers;
        call.reasons = c.reasons;
        call.unknown_tool = c.unknown_tool;

        const kind = sessionEventKind(call.function_name);
        if (kind) {
          governance.sessions.record(sessionKey, kind);
          if (kind === "send") counts.sends += 1;
          else counts.deletes += 1;
        }
      }

      corpus?.record(calls);
      req.log.info(
        {
          api: "messages",
          response_id: calls[0].response_id,
          model: calls[0].response_model ?? requestModel,
          tool_calls: calls.map((c) => c.function_name),
          decisions: calls.map((c) => c.decision),
          held: calls.filter((c) => c.decision === "HOLD").map((c) => c.function_name),
        },
        "tool calls observed"
      );
    }
  } catch (err) {
    req.log.warn({ err: String(err) }, "messages inspection skipped");
  }

  const auditDecisions = (holdId?: string) => {
    for (const call of calls) {
      governance.audit?.append({
        type: "decision",
        ts: new Date().toISOString(),
        response_id: call.response_id,
        model: call.response_model ?? requestModel,
        function_name: call.function_name,
        action_class: call.action_class,
        triggers: call.triggers,
        decision: call.decision,
        enforced: governance.enforcing,
        hold_id: call.decision === "HOLD" ? holdId : undefined,
        args_bytes: call.args_bytes,
      });
    }
  };

  const anyHold = calls.some((c) => c.decision === "HOLD");
  const willHold = anyHold && governance.holds !== null;

  if (willHold) {
    const ct = String(result.headers["content-type"] ?? "");
    const { id, outcome } = governance.holds!.createAndWait({
      responseBody: result.body,
      calls,
      timeoutMs: governance.holdTimeoutMs,
      model: calls[0]?.response_model ?? requestModel,
      responseId: calls[0]?.response_id,
    });
    auditDecisions(id);
    governance.audit?.append({
      type: "hold_transition",
      ts: new Date().toISOString(),
      hold_id: id,
      status: "PENDING",
    });

    req.raw.once("close", () => governance.holds?.clientClosed(id));

    const hold = governance.holds!.get(id);
    if (hold) {
      void governance.notifier?.notifyHold(hold, governance.holdTimeoutMs / 1000);
      req.log.info(
        { hold_id: id, api: "messages", approve: `phinq approve ${id}`, deny: `phinq deny ${id}` },
        "awaiting operator decision"
      );
    }

    const decision = await outcome;
    req.log.info(
      { hold_id: id, outcome: decision, latency_ms: Date.now() - started },
      "hold completed"
    );

    if (decision === "APPROVED") {
      reply.code(result.status).headers(result.headers).send(result.body);
      return;
    }
    const reason = decision === "DENIED" ? "denied" : "timeout";
    const denial = syntheticMessagesDenial(result.body.toString("utf8"), ct, reason);
    reply.code(200).header("content-type", denial.contentType).send(denial.body);
    return;
  }

  if (calls.length > 0) auditDecisions();
  reply.code(result.status).headers(result.headers).send(result.body);
}

async function blindPassthrough(
  req: FastifyRequest,
  reply: FastifyReply,
  config: ProxyConfig
): Promise<void> {
  const result = await forwardOrFail(req, reply, config, { started: Date.now() });
  if (!result) return;
  reply.code(result.status).headers(result.headers).send(result.body);
}

/** Forward to upstream; on failure send the OpenAI-style error and return null. */
async function forwardOrFail(
  req: FastifyRequest,
  reply: FastifyReply,
  config: ProxyConfig,
  meta: { model?: string; started: number },
  route?: { upstream?: string; path?: string }
): Promise<UpstreamResult | null> {
  try {
    const result = await forwardToUpstream(
      {
        method: req.method,
        path: route?.path ?? normalizeUpstreamPath(req.url),
        headers: req.headers,
        body: req.body as Buffer | undefined,
      },
      config,
      route?.upstream
    );
    req.log.info(
      {
        path: req.url,
        model: meta.model,
        status: result.status,
        latency_ms: Date.now() - meta.started,
      },
      "relayed"
    );
    return result;
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    req.log.error({ path: req.url, err: String(err) }, "upstream failure");
    reply.code(timedOut ? 504 : 502).send({
      error: {
        message: timedOut
          ? `Upstream timed out after ${config.upstreamTimeoutMs}ms.`
          : "Upstream unreachable.",
        type: "upstream_error",
        code: timedOut ? "upstream_timeout" : "upstream_unreachable",
      },
    });
    return null;
  }
}
