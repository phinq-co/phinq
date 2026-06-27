export interface ProxyConfig {
  /** Port to listen on. */
  port: number;
  /** Host to bind. Loopback by default; set 0.0.0.0 in Docker. */
  host: string;
  /** Upstream origin (no path) for OpenAI-style traffic (chat + responses). */
  upstream: string;
  /** Upstream origin for the Anthropic Messages API (`/v1/messages`). */
  anthropicUpstream: string;
  /**
   * Per-request upstream timeout. Kept below Hermes's 300s non-stream
   * stale detector so the proxy fails before the agent silently hangs up
   * (see DAY0-FINDINGS.md §2).
   */
  upstreamTimeoutMs: number;
  /**
   * JSONL file where observed tool calls are appended (component 2).
   * Set PHINQ_TOOLCALL_LOG="" to disable corpus capture entirely.
   */
  toolCallLogPath: string;
  /** phinq.yaml with classifier overrides (component 3). Missing file = defaults. */
  phinqConfigPath: string;
  /** SQLite file for session velocity counters. ":memory:" for ephemeral. */
  sessionDbPath: string;
  /** SQLite file for held responses (component 4). */
  holdDbPath: string;
  /** Hash-chained JSONL audit log (component 5). "" disables. */
  auditLogPath: string;
  /** Enforce HOLD decisions (component 4). Off = shadow mode. */
  enforce: boolean;
  /**
   * Approval window. Default 240s — must end before the agent's client gives
   * up (Hermes stale detector: 300s stock). Validation warns above 240.
   */
  holdTimeoutSeconds: number;
  /** Telegram bot token (secret — env only, never phinq.yaml, never logged). */
  telegramBotToken?: string;
  /** Operator chat id; only this chat's callbacks are honored. */
  telegramChatId?: string;
  /** Telegram API origin — overridable for tests. */
  telegramApiBase: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  return {
    port: intFromEnv(env.PHINQ_PORT, 5100),
    host: env.PHINQ_HOST ?? "127.0.0.1",
    upstream: (env.PHINQ_UPSTREAM ?? "https://openrouter.ai").replace(/\/+$/, ""),
    anthropicUpstream: (env.PHINQ_ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com").replace(
      /\/+$/,
      ""
    ),
    upstreamTimeoutMs: intFromEnv(env.PHINQ_UPSTREAM_TIMEOUT_MS, 280_000),
    toolCallLogPath: env.PHINQ_TOOLCALL_LOG ?? "phinq-toolcalls.jsonl",
    phinqConfigPath: env.PHINQ_CONFIG ?? "phinq.yaml",
    sessionDbPath: env.PHINQ_SESSION_DB ?? "phinq-session.db",
    holdDbPath: env.PHINQ_HOLD_DB ?? "phinq-holds.db",
    auditLogPath: env.PHINQ_AUDIT_LOG ?? "phinq-audit.jsonl",
    enforce: env.PHINQ_ENFORCE === "1" || env.PHINQ_ENFORCE === "true",
    holdTimeoutSeconds: intFromEnv(env.PHINQ_HOLD_TIMEOUT_S, 240),
    telegramBotToken: env.PHINQ_TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.PHINQ_TELEGRAM_CHAT_ID || undefined,
    telegramApiBase: (env.PHINQ_TELEGRAM_API ?? "https://api.telegram.org").replace(/\/+$/, ""),
  };
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
