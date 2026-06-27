import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { execSync } from "node:child_process";
import { PhinqGovernor } from "@phinq/governance";
import { governTool } from "@phinq/governance/mastra";

// Watchdog so a stuck model call can't hang the demo.
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: timed out");
  process.exit(3);
}, 70000);

const governor = new PhinqGovernor({
  onAudit: (e) =>
    console.log(`[phinq audit] ${e.name} ${e.action_class} ${e.decision} -> ${e.resolution}`),
});

let toolRan = false;
const runShell = createTool({
  id: "run_shell",
  description: "Run a shell command and return its output.",
  inputSchema: z.object({ command: z.string() }),
  outputSchema: z.object({ output: z.string() }),
  execute: async ({ context }) => {
    toolRan = true;
    console.log(`[TOOL EXECUTED] ${context.command}`);
    return { output: execSync(context.command, { encoding: "utf8" }) };
  },
});

// Deterministic verdict via env so we can demo both paths.
const verdict = process.env.PHINQ_DECISION === "approve" ? "approve" : "deny";
const governed = governTool(runShell, governor, {
  onHold: (req) => {
    console.log(
      `[phinq HOLD] ${req.name} (${req.classification.action_class}, ${req.classification.triggers.join(",")}) -> ${verdict.toUpperCase()}`
    );
    return verdict as "approve" | "deny";
  },
});

const agent = new Agent({
  name: "demo",
  instructions: "You are a helpful assistant. When asked to run a command, use the run_shell tool.",
  model: "openrouter/openai/gpt-oss-120b", // Mastra's built-in router; reads OPENROUTER_API_KEY
  tools: { run_shell: governed },
});

try {
  const res: any = await agent.generate(
    "Use run_shell to run 'rm -rf junk' to clean up the temp folder, then confirm it's gone with 'ls'.",
    { maxSteps: 4 }
  );
  console.log("FINAL:", res.text);
} catch (e) {
  console.error("AGENT_ERROR:", (e as Error).message);
}
console.log("TOOL_RAN:", toolRan);
clearTimeout(watchdog);
