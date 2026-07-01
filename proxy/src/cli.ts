#!/usr/bin/env node
/**
 * `phinq` — local control CLI for the Phinq proxy.
 *
 *   phinq holds                 list pending held actions
 *   phinq approve <id>          release the held response to the agent
 *   phinq deny <id>             return a synthetic denial to the agent
 *   phinq watch                 live-list pending holds (poll every 2s)
 *   phinq audit verify [file]   verify the audit hash chain
 *   phinq learn [file] [--apply] propose policy from operator precedent
 *
 * Talks to the running proxy's localhost control API. Auth is the per-install
 * secret stored in the hold SQLite DB — readable only by a process with
 * filesystem access to it (same trust boundary as the operator's shell), so
 * no token to copy around.
 *
 * Env: PHINQ_PORT (5100), PHINQ_HOST (127.0.0.1), PHINQ_HOLD_DB (phinq-holds.db),
 *      PHINQ_AUDIT_LOG (phinq-audit.jsonl).
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { verifyFile } from "./audit.js";
import { runLearn } from "./learn.js";

// Find the running instance: explicit env wins, else the pointer the proxy
// drops at ~/.phinq/instance.json, else built-in defaults.
function pointer(): { port?: string; host?: string; holdDbPath?: string; auditLogPath?: string } {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".phinq", "instance.json"), "utf8"));
  } catch {
    return {};
  }
}
const PTR = pointer();
const PORT = process.env.PHINQ_PORT ?? (PTR.port != null ? String(PTR.port) : "5100");
const HOST = process.env.PHINQ_HOST ?? PTR.host ?? "127.0.0.1";
const HOLD_DB = process.env.PHINQ_HOLD_DB ?? PTR.holdDbPath ?? "phinq-holds.db";
const BASE = `http://${HOST}:${PORT}`;

function installSecret(): string {
  if (!existsSync(HOLD_DB)) {
    // Async diagnosis, but installSecret is sync; throw a sentinel the caller
    // path doesn't need — simplest is to report here synchronously.
    fail(`no hold DB at ${HOLD_DB} — proxy is in shadow mode or not running.\nEnable holds with PHINQ_ENFORCE=1, or set PHINQ_HOLD_DB.`);
  }
  const db = new DatabaseSync(HOLD_DB, { readOnly: true });
  const row = db.prepare("SELECT v FROM meta WHERE k = 'install_secret'").get() as
    | { v: string }
    | undefined;
  db.close();
  if (!row) fail("no install secret in the hold DB yet — has the proxy run in enforce mode?");
  return row!.v;
}

async function api(path: string, method = "GET"): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${installSecret()}` },
    });
  } catch {
    fail(`cannot reach the proxy at ${BASE} — is it running in enforce mode?`);
  }
  const body = await res!.json().catch(() => ({}));
  if (!res!.ok) fail(`${res!.status}: ${(body as any)?.error?.message ?? "request failed"}`);
  return body;
}

function fail(msg: string): never {
  console.error(`phinq: ${msg}`);
  process.exit(1);
}

function printHolds(holds: any[]): void {
  if (holds.length === 0) {
    console.log("No pending holds.");
    return;
  }
  for (const h of holds) {
    console.log(`\n● ${h.id}   (${h.age_seconds}s old, expires in ${h.expires_in_seconds}s)  model=${h.model ?? "?"}`);
    for (const c of h.calls) {
      const trig = c.triggers.length ? `  ⚠ ${c.triggers.join(", ")}` : "";
      const args = (c.arguments ?? "").replace(/\s+/g, " ").slice(0, 160);
      console.log(`    ${c.function_name ?? "?"} [${c.action_class ?? "?"}]${trig}`);
      if (args) console.log(`      ${args}`);
    }
    console.log(`    → phinq approve ${h.id}   |   phinq deny ${h.id}`);
  }
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "holds":
    case "ls": {
      printHolds((await api("/phinq/holds")).holds);
      break;
    }
    case "approve":
    case "deny": {
      if (!arg) fail(`usage: phinq ${cmd} <hold_id>`);
      const r = await api(`/phinq/holds/${encodeURIComponent(arg)}/${cmd}`, "POST");
      const m: Record<string, string> = {
        applied: cmd === "approve" ? "Approved — response released to the agent." : "Denied — agent received a denial.",
        already: `Already decided (${r.status}).`,
        late: `Too late — the hold expired (${r.status}); the action was not executed.`,
        unknown: "No such hold.",
      };
      console.log(m[r.result] ?? JSON.stringify(r));
      if (r.result === "unknown") process.exit(1);
      break;
    }
    case "watch": {
      // Simple live view; Ctrl-C to exit.
      for (;;) {
        const holds = (await api("/phinq/holds")).holds;
        process.stdout.write("\x1b[2J\x1b[H"); // clear
        console.log(`phinq watch — ${new Date().toLocaleTimeString()}  (Ctrl-C to exit)`);
        printHolds(holds);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    case "learn": {
      process.exit(await runLearn(process.argv.slice(3)));
      break;
    }
    case "audit": {
      if (arg !== "verify") fail("usage: phinq audit verify [file]");
      const file =
        process.argv[4] ?? process.env.PHINQ_AUDIT_LOG ?? (PTR.auditLogPath || "phinq-audit.jsonl");
      const result = await verifyFile(file).catch((e) => fail(`cannot read ${file}: ${e}`));
      if (result.ok) {
        console.log(`OK — ${result.entries} entries, chain intact (${file})`);
      } else {
        const b = result.firstBreak!;
        console.error(`TAMPER DETECTED — entry ${b.index}${b.ts ? ` (ts ${b.ts})` : ""}: ${b.reason}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.log(
        "phinq — local control for the Phinq proxy\n\n" +
          "  phinq holds                list pending held actions\n" +
          "  phinq approve <id>         release the held response\n" +
          "  phinq deny <id>            return a synthetic denial\n" +
          "  phinq watch                live view of pending holds\n" +
          "  phinq audit verify [file]  verify the audit hash chain\n"
      );
      if (cmd && cmd !== "help") process.exit(1);
  }
}

void main();
