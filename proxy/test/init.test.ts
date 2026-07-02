import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRuntimes,
  snippetFor,
  buildEnvFile,
  starterYaml,
  loadEnvFile,
} from "../src/init.js";

test("detectRuntimes finds known agents from home-dir markers", async () => {
  const home = await mkdtemp(join(tmpdir(), "phinq-home-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".hermes"), { recursive: true });
  await writeFile(join(home, ".hermes", "config.yaml"), "model:\n");

  const found = detectRuntimes(home);
  const ids = found.map((r) => r.id);
  assert.ok(ids.includes("claude-code"));
  assert.ok(ids.includes("codex"));
  assert.ok(ids.includes("hermes"));
  assert.ok(!ids.includes("cursor"));
  await rm(home, { recursive: true, force: true });
});

test("empty home detects nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "phinq-home-"));
  assert.equal(detectRuntimes(home).length, 0);
  await rm(home, { recursive: true, force: true });
});

test("snippets carry the right wiring per runtime", () => {
  assert.match(snippetFor("claude-code"), /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:5100 claude/);
  assert.match(snippetFor("claude-code"), /phinq-mcp/);
  assert.match(snippetFor("codex"), /wire_api = "responses"/);
  assert.match(snippetFor("hermes"), /base_url: http:\/\/127\.0\.0\.1:5100\/api\/v1/);
  assert.match(snippetFor("generic"), /never stores it/);
});

test("env file reflects answers and keeps everything under ~/.phinq", () => {
  const env = buildEnvFile(
    { enforce: true, telegramToken: "t-123", telegramChatId: "42" },
    "/home/u/.phinq"
  );
  assert.match(env, /PHINQ_ENFORCE=1/);
  assert.match(env, /PHINQ_TELEGRAM_BOT_TOKEN=t-123/);
  assert.match(env, /PHINQ_AUDIT_LOG=\/home\/u\/\.phinq\/audit\.jsonl/);
  assert.match(env, /PHINQ_CONFIG=\/home\/u\/\.phinq\/phinq\.yaml/);

  const watch = buildEnvFile({ enforce: false }, "/home/u/.phinq");
  assert.ok(!watch.includes("PHINQ_ENFORCE"));
  assert.ok(!watch.includes("TELEGRAM"));
});

test("starter yaml parses as valid config surface", () => {
  const y = starterYaml();
  assert.match(y, /external_comm_volume: 3/);
  assert.match(y, /# session_token_budget/);
});

test("loadEnvFile sets vars without clobbering existing env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phinq-env-"));
  const p = join(dir, "phinq.env");
  process.env.PHINQ_TEST_EXISTING = "keep-me";
  await writeFile(
    p,
    "# comment\nPHINQ_TEST_NEW=hello\nPHINQ_TEST_EXISTING=overwrite-attempt\n\nbroken-line\n"
  );
  const n = loadEnvFile(p);
  assert.equal(n, 1);
  assert.equal(process.env.PHINQ_TEST_NEW, "hello");
  assert.equal(process.env.PHINQ_TEST_EXISTING, "keep-me");
  delete process.env.PHINQ_TEST_NEW;
  delete process.env.PHINQ_TEST_EXISTING;
  assert.equal(loadEnvFile(join(dir, "missing.env")), 0);
  await rm(dir, { recursive: true, force: true });
});
