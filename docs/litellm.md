# Phinq × LiteLLM

Two ways to govern agents that already route through the [LiteLLM gateway](https://github.com/BerriAI/litellm). Use either — or both.

## Pattern A — chain the proxies (full hold-for-approval)

Point LiteLLM's upstream at Phinq. You keep LiteLLM's key management, spend tracking, and provider fan-out; Phinq adds tool-call classification, human-in-the-loop holds (Telegram/Slack/CLI), and the tamper-evident audit log.

```
agent → LiteLLM gateway → Phinq proxy → provider
```

Start Phinq in front of your provider:

```bash
cd phinq/proxy
PHINQ_UPSTREAM=https://api.openai.com PHINQ_ENFORCE=1 npm start   # listens on 127.0.0.1:5100
```

Then in LiteLLM's `config.yaml`, aim the model at Phinq:

```yaml
model_list:
  - model_name: gpt-4o-governed
    litellm_params:
      model: openai/gpt-4o
      api_base: http://127.0.0.1:5100/v1   # Phinq, not the provider
      api_key: os.environ/OPENAI_API_KEY   # flows through; Phinq never stores it
```

Held actions pause inside Phinq until an operator approves — LiteLLM just sees a slow response, and denials come back as clean assistant messages the agent can handle.

## Pattern B — in-process guardrail (classify + block, no extra hop)

`pip install phinq` on the LiteLLM host, then register the guardrail:

```yaml
guardrails:
  - guardrail_name: phinq
    litellm_params:
      guardrail: phinq.litellm_guardrail.PhinqGuardrail
      mode: post_call        # inspects the tool calls the model proposes
      enforce: true          # false = shadow mode (log only, block nothing)
```

Every response's proposed tool calls run through Phinq's deterministic classifier (the same engine as the proxy — no LLM judge, microsecond latency). Calls that classify HOLD — bulk deletes, credential access, permission escalation, billing changes, comms-volume blasts — raise a `PhinqHoldError`, which LiteLLM returns to the caller as a guardrail violation. In shadow mode they are logged and passed through.

Start with `enforce: false`, watch the logs for would-be HOLDs, tune thresholds, then flip to `true` — same calibration workflow as the proxy.

### What Pattern B does *not* give you

A hard block, not a pause: there's no approve/deny button and no audit chain. When you want a human to make the call — and verifiable evidence that they did — use Pattern A.

## Which to pick

| | Pattern A (chained proxy) | Pattern B (guardrail) |
|---|---|---|
| Human approval (Telegram/Slack/CLI) | ✅ | — |
| Tamper-evident audit + `phinq report` | ✅ | — |
| Zero extra infrastructure | — | ✅ |
| Latency added | ~1 ms passthrough | ~µs in-process |
| Blocked calls | held, then approved/denied | rejected immediately |
