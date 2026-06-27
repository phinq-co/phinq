# Phinq

**The open-source governance layer for autonomous AI agents.** Know what your agent did. Stop it before it doesn't.

Phinq sits between your agent and the world, classifies every action it tries to take, holds the dangerous ones for your approval, and writes a tamper-evident audit log of everything. Two ways to run it:

- **Proxy** — drop it in front of any agent that speaks the OpenAI or Anthropic APIs (just set `base_url`). No agent-code change. Governs Chat Completions, the Responses API, and Anthropic Messages.
- **SDK** (`@phinq/governance`) — import it into a TypeScript agent and gate tool execution **in-process**, before it runs. Provider-agnostic.

Both share one deterministic decision engine, one audit format, and one set of risk rules.

## What it does

- **Classifies every action by risk** — reversible actions pass; irreversible ones (deletes, credential access, payments, bulk operations, comms volume) are held.
- **Holds high-risk actions for a human** — approve or deny from your phone, the `phinq` CLI, or a programmatic handler; auto-denies on timeout.
- **Tamper-evident audit log** — hash-chained (RFC 8785 JCS, SHA-256), so any edit, reorder, or deletion of history is detectable.
- **Velocity awareness** — catches "the swarm sent 50 emails" / "300 calls in two minutes" via rolling-window triggers.

## Repo layout

| Path | What it is |
|------|------------|
| `proxy/` | The governance proxy (Fastify/TypeScript) — 3 API dialects, holds, audit log, CLI |
| `sdk/` | `@phinq/governance` — the in-process TypeScript SDK + framework adapters (Mastra, …) |
| `PROXY-MVP.md` | Design spec |

The classifier (`proxy/src/classifier.ts`) is the single source of truth; the SDK syncs it at build time so the two can never drift.

## Quick start — proxy

```bash
cd proxy
npm install && npm run build && npm start    # listens on 127.0.0.1:5100
# then point your agent's base_url at http://127.0.0.1:5100/api/v1
```

## Quick start — SDK

```ts
import { PhinqGovernor } from "@phinq/governance";

const governor = new PhinqGovernor();
const { allowed } = await governor.gate(
  { name: "run_shell", args: { command } },
  { onHold: (req) => askOperator(req) }   // "approve" | "deny"
);
if (allowed) await runTool();
```

## Works with

OpenRouter, OpenAI (Codex, Agents SDK), Anthropic, Mastra, LangChain/LangGraph, Vercel AI SDK, CrewAI, AutoGen, Pydantic AI, LlamaIndex, Hugging Face, and any runtime that speaks the OpenAI/Anthropic APIs with a configurable base URL. *(Compatibility, not affiliation — trademarks belong to their owners.)*

## Related

- **Advisory skill** (lighter, no infra): [github.com/hythamh12/phinq-governance](https://github.com/hythamh12/phinq-governance)
- **Hosted** (dashboards, anomaly detection, team approvals, compliance-grade audit): [phinq.co](https://www.phinq.co)

## License

MIT
# phinq
