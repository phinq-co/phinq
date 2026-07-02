# phinq

**The runtime checkpoint for AI agents.** Phinq watches every action your agent or automation takes, pauses the risky ones until you approve (terminal, Telegram, or Slack), and keeps a tamper-evident record of everything — verifiable evidence of human oversight.

## Two-minute start

```bash
npx phinq
```

The setup wizard detects what you run (Claude Code, Codex, Hermes, MCP servers…), asks three plain-English questions, and prints the one line to paste. Then:

```bash
phinq start     # start the checkpoint
phinq watch     # live view of anything held
```

Your existing API key keeps working — Phinq passes it through and never stores or logs it. It starts in **watch-only mode**: nothing is blocked until you say so.

## What you get

- **Every action classified by risk** — deterministic rules, not another LLM. Deletes, credential access, payments, bulk sends, permission changes, runaway token burn.
- **Approve/Deny from wherever you are** — terminal, Telegram, or Slack. No answer in time = auto-deny.
- **A record you can prove** — hash-chained audit log; `phinq report` turns it into a human-oversight report (false-hold rate, damage prevented, token spend).
- **A checkpoint that learns** — `phinq learn` turns your approve/deny history into cited policy proposals.
- **MCP gateway** — wrap any MCP server: `npx phinq-mcp --enforce -- <server command>`.

## Everything else

Full docs, configuration, the risk model, SDKs (TypeScript in-process + `pip install phinq` for Python), and the LiteLLM integration: **[phinq.co/docs](https://www.phinq.co/docs)** · **[github.com/phinq-co/phinq](https://github.com/phinq-co/phinq)**

MIT licensed.
