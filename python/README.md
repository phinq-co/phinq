# phinq (Python)

The runtime checkpoint for AI agents — deterministic tool-call risk classification, human-in-the-loop gating, and audit hooks. This is the Python port of the same engine the [Phinq proxy](https://github.com/phinq-co/phinq) uses; the test suite mirrors the TypeScript cases so the two engines provably agree.

```bash
pip install phinq
```

Requires **Python 3.10+**. If that fails with `No matching distribution found`, check your Python version (`python3 --version`) — macOS's built-in Python is often 3.9. Install a newer one (e.g. `brew install python@3.11`) and use that interpreter's `pip` instead.

## Gate a tool execution

```python
from phinq import PhinqGovernor

governor = PhinqGovernor()

def ask_operator(req):
    print(f"HOLD: {req.name} — {', '.join(req.classification.reasons)}")
    return "approve" if input("approve? [y/N] ").lower() == "y" else "deny"

result = governor.gate("delete_file", {"path": "/data/old"}, on_hold=ask_operator)
if result.allowed:
    run_tool()
```

- **ALLOW** decisions pass straight through (`resolution == "allowed"`).
- **HOLD** decisions call your `on_hold` handler (returns `"approve"` or `"deny"`), auto-denying on timeout (`hold_timeout_s`, default 240s).
- With no handler, held calls are denied by default (`default_on_hold="approve"` flips this).

## Classify only

```python
from phinq import classify_tool_call

c = classify_tool_call("shell_exec", '{"cmd": "sudo rm -rf /data"}')
c.decision      # "HOLD"
c.action_class  # AgentActionClass.IRREVERSIBLE_HIGH
c.triggers      # ["PERMISSION_ESCALATION", "BULK_DELETE"]
c.reasons       # human-readable, one per rule that fired
```

Deterministic: same call + same session counts → same decision. No network, no LLM judge.

## Velocity triggers

The governor tracks per-session rolling windows (60 min): outbound-comms volume, delete counts, and bulk-operations-after-an-error. The fourth send in a session holds even though each send looks innocent alone.

```python
governor.record_error()          # arms AFTER_ERROR_BULK for 10 minutes
governor.gate("send_email", {...}, session_key="agent-7")
```

## Audit hook

```python
events = []
governor = PhinqGovernor(on_audit=events.append)
```

Every gate emits an `AuditEvent` (never containing arguments — only sizes and classifications). Feed these to your logger, or run the [Phinq proxy](https://github.com/phinq-co/phinq) for the full hash-chained, tamper-evident audit log and the `phinq report` oversight evidence.

## Tuning

```python
from phinq import ClassifierRules, ClassifierThresholds, AgentActionClass, PhinqGovernor

rules = ClassifierRules(
    thresholds=ClassifierThresholds(external_comm_volume=10, bulk_delete_count=20),
    tool_class_overrides={"send_newsletter": AgentActionClass.REVERSIBLE},
)
governor = PhinqGovernor(rules=rules)
```

## License

MIT
