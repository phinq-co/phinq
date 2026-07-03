#!/usr/bin/env node
/**
 * `phinq-mcp` — wrap any stdio MCP server with the Phinq checkpoint.
 *
 *   npm run mcp -- [--enforce] -- <command> [args...]
 *
 * Example (Claude Code / any MCP client config):
 *   { "command": "npx", "args": ["-y", "phinq-mcp", "--enforce", "--",
 *     "npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"] }
 *
 * Configuration via the same env vars as the proxy: PHINQ_ENFORCE,
 * PHINQ_AUDIT_LOG, PHINQ_HOLD_DB, PHINQ_HOLD_TIMEOUT_S, PHINQ_CONFIG,
 * PHINQ_TELEGRAM_*, PHINQ_SLACK_*. All gateway logging goes to stderr —
 * stdout carries the MCP protocol only.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.js";
import { loadPhinqRules } from "./phinq-config.js";
import { HoldStore } from "./holds.js";
import { TelegramNotifier } from "./telegram.js";
import { CompositeNotifier, SlackNotifier, type HoldNotifier } from "./slack.js";
import { AuditLog } from "./audit.js";
import { McpGateway } from "./mcp-gateway.js";

function main(): void {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const flags = sep === -1 ? argv : argv.slice(0, sep);
  const childCmd = sep === -1 ? [] : argv.slice(sep + 1);
  if (childCmd.length === 0) {
    process.stderr.write(
      "usage: phinq-mcp [--enforce] -- <command> [args...]\n" +
        "       wraps the given stdio MCP server with the Phinq checkpoint\n"
    );
    process.exit(2);
  }

  const config = loadConfig();
  const enforce = config.enforce || flags.includes("--enforce");
  const log = (msg: string) => process.stderr.write(`[phinq-mcp] ${msg}\n`);
  const stderrLog = {
    info: (_o: object, m: string) => log(m),
    warn: (_o: object, m: string) => log(m),
    error: (_o: object, m: string) => log(m),
  };

  const phinq = loadPhinqRules(config.phinqConfigPath, log);
  const audit = config.auditLogPath ? new AuditLog(config.auditLogPath, log) : null;

  let holds: HoldStore | null = null;
  let notifier: HoldNotifier | null = null;
  if (enforce) {
    holds = new HoldStore(config.holdDbPath, stderrLog);
    holds.installSecret();
    holds.addTransitionListener((hold) => {
      audit?.append({
        type: "hold_transition",
        ts: new Date().toISOString(),
        hold_id: hold.id,
        status: hold.status,
        decided_by: hold.decided_by,
      });
    });
    const notifiers: HoldNotifier[] = [];
    const telegramChatId = config.telegramChatId ?? phinq.telegram.operatorChatId;
    if (config.telegramBotToken && telegramChatId) {
      notifiers.push(
        new TelegramNotifier(
          { botToken: config.telegramBotToken, operatorChatId: telegramChatId, apiBase: config.telegramApiBase },
          holds,
          stderrLog
        )
      );
    }
    if (config.slackBotToken && config.slackAppToken && config.slackChannel) {
      notifiers.push(
        new SlackNotifier(
          {
            botToken: config.slackBotToken,
            appToken: config.slackAppToken,
            channel: config.slackChannel,
            operatorIds: config.slackOperatorIds,
            apiBase: config.slackApiBase,
          },
          holds,
          stderrLog
        )
      );
    }
    if (notifiers.length > 0) {
      notifier = notifiers.length === 1 ? notifiers[0] : new CompositeNotifier(notifiers);
      notifier.start();
    }
    log(`enforcement ACTIVE — holds enabled (approve via \`phinq approve <id>\`${notifiers.length ? " or your configured channels" : ""})`);
  } else {
    log("shadow mode — decisions audited, nothing held");
  }

  const gateway = new McpGateway({
    rules: phinq.rules,
    enforce,
    holds,
    notifier,
    audit,
    holdTimeoutMs: (phinq.hold.timeoutSeconds ?? config.holdTimeoutSeconds) * 1000,
    log,
  });

  const child = spawn(childCmd[0], childCmd.slice(1), {
    stdio: ["pipe", "pipe", "inherit"], // child stderr passes straight through
  });
  child.on("error", (err) => {
    log(`failed to start wrapped server: ${String(err)}`);
    process.exit(1);
  });
  child.on("exit", (code) => {
    notifier?.stop();
    process.exit(code ?? 0);
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  const toServer = (line: string) => child.stdin.write(line + "\n");
  const toClient = (line: string) => process.stdout.write(line + "\n");

  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    void gateway.handleClientLine(line, toServer, toClient).catch((err) => {
      log(`gateway error: ${String(err)}`);
      toServer(line); // fail-open on internal errors: never wedge the agent
    });
  });
  process.stdin.on("end", () => child.stdin.end());

  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    gateway.handleServerLine(line, toClient);
  });
}

main();
