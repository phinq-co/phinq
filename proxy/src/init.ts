/**
 * `npx @phinq/phinq` — the two-minute setup. (Scoped interim name while
 *  the bare `phinq` package name request is pending with npm support.)
 *
 * A plain-English wizard for people who built an automation and want to
 * sleep at night. No yaml knowledge required: it detects what you run,
 * asks three questions, writes everything into ~/.phinq/, and prints the
 * one line to paste. The full config surface (README) is still there for
 * when you outgrow the defaults.
 *
 * Everything here is dependency-free (node:readline) and the pure parts
 * (detection, snippets, file contents) are exported for tests.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

export interface Runtime {
  id: string;
  name: string;
  /** How we knew it's here. */
  evidence: string;
}

/** Look around the machine for agent runtimes we know how to wire. */
export function detectRuntimes(home: string = homedir()): Runtime[] {
  const found: Runtime[] = [];
  const has = (p: string) => existsSync(join(home, p));
  if (has(".claude") || has(".claude.json")) {
    found.push({ id: "claude-code", name: "Claude Code", evidence: "~/.claude" });
  }
  if (has(".codex/config.toml") || has(".codex")) {
    found.push({ id: "codex", name: "Codex CLI", evidence: "~/.codex" });
  }
  if (has(".hermes/config.yaml")) {
    found.push({ id: "hermes", name: "Hermes", evidence: "~/.hermes/config.yaml" });
  }
  if (has(".cursor")) {
    found.push({ id: "cursor", name: "Cursor", evidence: "~/.cursor" });
  }
  return found;
}

const PROXY_URL = "http://127.0.0.1:5100";

/** The one thing to paste, per runtime — plain words, no jargon. */
export function snippetFor(runtimeId: string): string {
  switch (runtimeId) {
    case "claude-code":
      return [
        "Run Claude Code through the checkpoint with one environment variable:",
        "",
        `  ANTHROPIC_BASE_URL=${PROXY_URL} claude`,
        "",
        "Or protect its MCP tools instead — wrap any server in your MCP config:",
        `  "command": "npx", "args": ["-y", "-p", "@phinq/phinq", "phinq-mcp", "--enforce", "--", "<the original command>"]`,
      ].join("\n");
    case "codex":
      return [
        "Add a provider to ~/.codex/config.toml and select it:",
        "",
        `  [model_providers.phinq]`,
        `  name = "Phinq"`,
        `  base_url = "${PROXY_URL}/v1"`,
        `  wire_api = "responses"`,
        `  env_key = "OPENROUTER_API_KEY"   # or OPENAI_API_KEY`,
        "",
        `  model_provider = "phinq"`,
      ].join("\n");
    case "hermes":
      return [
        "Point Hermes at the checkpoint in ~/.hermes/config.yaml:",
        "",
        `  model:`,
        `    base_url: ${PROXY_URL}/api/v1`,
      ].join("\n");
    case "cursor":
    default:
      return [
        "Point your agent's OpenAI-style base URL at the checkpoint:",
        "",
        `  base_url = ${PROXY_URL}/api/v1     # OpenAI-style APIs`,
        `  base_url = ${PROXY_URL}            # Anthropic SDK`,
        "",
        "Your existing API key keeps working — Phinq passes it through and never stores it.",
      ].join("\n");
  }
}

export interface InitAnswers {
  enforce: boolean;
  telegramToken?: string;
  telegramChatId?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackChannel?: string;
}

/** ~/.phinq/phinq.env — everything the proxy needs, one folder, no yaml. */
export function buildEnvFile(a: InitAnswers, phinqDir: string): string {
  const lines = [
    "# Written by `npx @phinq/phinq` — safe to edit. Loaded by `phinq start`.",
    `PHINQ_CONFIG=${join(phinqDir, "phinq.yaml")}`,
    `PHINQ_AUDIT_LOG=${join(phinqDir, "audit.jsonl")}`,
    `PHINQ_TOOLCALL_LOG=${join(phinqDir, "toolcalls.jsonl")}`,
    `PHINQ_HOLD_DB=${join(phinqDir, "holds.db")}`,
    `PHINQ_SESSION_DB=${join(phinqDir, "session.db")}`,
  ];
  if (a.enforce) lines.push("PHINQ_ENFORCE=1");
  if (a.telegramToken && a.telegramChatId) {
    lines.push(`PHINQ_TELEGRAM_BOT_TOKEN=${a.telegramToken}`);
    lines.push(`PHINQ_TELEGRAM_CHAT_ID=${a.telegramChatId}`);
  }
  if (a.slackBotToken && a.slackAppToken && a.slackChannel) {
    lines.push(`PHINQ_SLACK_BOT_TOKEN=${a.slackBotToken}`);
    lines.push(`PHINQ_SLACK_APP_TOKEN=${a.slackAppToken}`);
    lines.push(`PHINQ_SLACK_CHANNEL=${a.slackChannel}`);
  }
  return lines.join("\n") + "\n";
}

export function starterYaml(): string {
  return [
    "# Phinq rules — written by `npx @phinq/phinq`. Everything here is optional.",
    "# Docs: https://www.phinq.co/docs",
    "thresholds:",
    "  external_comm_volume: 3   # hold the 4th outbound message in an hour",
    "  bulk_delete_count: 5      # hold deletes touching more than 5 things",
    "  # session_token_budget: 500000   # un-comment to cap token burn per hour",
    "tools: {}                   # per-tool overrides land here (phinq learn proposes them)",
    "",
  ].join("\n");
}

/** Load KEY=VALUE lines into process.env (existing env wins). */
export function loadEnvFile(path: string): number {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (process.env[k] === undefined) {
      process.env[k] = v;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// The interactive flow
// ---------------------------------------------------------------------------

export async function runInit(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.log(
      "phinq setup is interactive — run it in a terminal.\n" +
        "Non-interactive alternative: see https://www.phinq.co/docs (env vars + phinq.yaml)."
    );
    return 2;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, fallback = ""): Promise<string> =>
    ((await rl.question(q)) || fallback).trim();

  console.log(`
   ┌─┐
   │ │  phinq — the runtime checkpoint for AI agents
   ·    watches every action · pauses the risky ones · keeps receipts
`);

  // 1. What are we protecting?
  const detected = detectRuntimes();
  console.log("What should Phinq protect?\n");
  detected.forEach((r, i) => console.log(`  ${i + 1}. ${r.name}   (found ${r.evidence})`));
  console.log(`  ${detected.length + 1}. Something else / just start the checkpoint\n`);
  const pick = parseInt(await ask(`Pick a number [1]: `, "1"), 10) || 1;
  const runtime = detected[pick - 1] ?? { id: "generic", name: "your agent", evidence: "" };

  // 2. How do you want to be reached?
  console.log(`\nWhen something risky comes up, where should the Approve/Deny buttons go?\n`);
  console.log("  1. Just my terminal (phinq approve <id>) — simplest, works today");
  console.log("  2. Telegram — a message on your phone");
  console.log("  3. Slack — a message in a channel\n");
  const notify = parseInt(await ask("Pick a number [1]: ", "1"), 10) || 1;

  const answers: InitAnswers = { enforce: false };
  if (notify === 2) {
    console.log("\nTelegram setup (2 minutes): message @BotFather → /newbot → copy the token.");
    console.log("Then message your new bot once, and get your chat id from @userinfobot.\n");
    answers.telegramToken = await ask("Bot token (paste, or Enter to skip): ");
    if (answers.telegramToken) answers.telegramChatId = await ask("Your chat id: ");
  } else if (notify === 3) {
    console.log("\nSlack setup: api.slack.com/apps → create app → enable Socket Mode.");
    console.log("You'll need the bot token (xoxb-…), app token (xapp-…), and a channel id.\n");
    answers.slackBotToken = await ask("Bot token (xoxb-…, or Enter to skip): ");
    if (answers.slackBotToken) {
      answers.slackAppToken = await ask("App token (xapp-…): ");
      answers.slackChannel = await ask("Channel id (C…): ");
    }
  }

  // 3. Watch or hold?
  console.log(`\nHow should Phinq start?\n`);
  console.log("  1. Watch only — log and classify everything, block nothing (recommended first)");
  console.log("  2. Hold risky actions — pause them until you approve\n");
  const mode = parseInt(await ask("Pick a number [1]: ", "1"), 10) || 1;
  answers.enforce = mode === 2;

  rl.close();

  // Write ~/.phinq/
  const phinqDir = join(homedir(), ".phinq");
  mkdirSync(phinqDir, { recursive: true });
  const yamlPath = join(phinqDir, "phinq.yaml");
  if (!existsSync(yamlPath)) writeFileSync(yamlPath, starterYaml());
  const envPath = join(phinqDir, "phinq.env");
  const existedBefore = existsSync(envPath);
  if (existedBefore) copyFileSync(envPath, envPath + ".bak");
  writeFileSync(envPath, buildEnvFile(answers, phinqDir), { mode: 0o600 });

  console.log(`\n✓ Wrote ${envPath}${existedBefore ? " (previous saved as .bak)" : ""}`);
  console.log(`✓ Wrote ${yamlPath} (rules — tune later, or let \`phinq learn\` propose changes)`);

  // The paste-line
  console.log(`\n─── Connect ${runtime.name} ───────────────────────────────\n`);
  console.log(snippetFor(runtime.id));
  console.log(`\n─── Run it ─────────────────────────────────────────────\n`);
  console.log("  phinq start          # starts the checkpoint (Ctrl-C stops it)");
  console.log("  phinq watch          # live view of anything held");
  console.log("  phinq learn          # after a while: let your decisions tune the rules");
  console.log(
    `\nMode: ${answers.enforce ? "HOLD — risky actions wait for you" : "watch only — nothing blocked"}. ` +
      `Change any time in ${envPath}.\n`
  );
  return 0;
}

/** `phinq start` — load ~/.phinq/phinq.env, then boot the proxy in-process. */
export async function runStart(): Promise<void> {
  const envPath = join(homedir(), ".phinq", "phinq.env");
  const loaded = loadEnvFile(envPath);
  if (loaded > 0) console.log(`phinq: loaded ${loaded} setting(s) from ${envPath}`);
  await import("./index.js");
}
