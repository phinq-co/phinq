"""Deterministic tool-call risk classifier — Python port of proxy/src/classifier.ts.

The TypeScript classifier is the source of truth; this module mirrors it
rule-for-rule and the test suite mirrors the TS cases so the engines provably
agree. Pure and deterministic: same call + same session counts -> same decision.
No network, no clock reads (the caller passes session counts in).

Action classes (action-classes.md):
    RISK_REDUCING < REVERSIBLE < IRREVERSIBLE_LOW < IRREVERSIBLE_MEDIUM
    < IRREVERSIBLE_HIGH

Structural triggers (triggers.md) always escalate to IRREVERSIBLE_HIGH.
Decision output is ALLOW or HOLD only.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class AgentActionClass(str, Enum):
    RISK_REDUCING = "RISK_REDUCING"
    REVERSIBLE = "REVERSIBLE"
    IRREVERSIBLE_LOW = "IRREVERSIBLE_LOW"
    IRREVERSIBLE_MEDIUM = "IRREVERSIBLE_MEDIUM"
    IRREVERSIBLE_HIGH = "IRREVERSIBLE_HIGH"


_CLASS_ORDER = [
    AgentActionClass.RISK_REDUCING,
    AgentActionClass.REVERSIBLE,
    AgentActionClass.IRREVERSIBLE_LOW,
    AgentActionClass.IRREVERSIBLE_MEDIUM,
    AgentActionClass.IRREVERSIBLE_HIGH,
]


def max_class(a: AgentActionClass, b: AgentActionClass) -> AgentActionClass:
    return a if _CLASS_ORDER.index(a) >= _CLASS_ORDER.index(b) else b


# The seven non-negotiable structural trigger categories.
StructuralTrigger = str  # "BULK_DELETE" | "CREDENTIAL_ACCESS" | "DISABLE_SAFEGUARDS"
#                          | "EXTERNAL_COMM_VOLUME" | "PERMISSION_ESCALATION"
#                          | "BILLING_MODIFICATION" | "AFTER_ERROR_BULK"

Decision = str  # "ALLOW" | "HOLD"


@dataclass
class SessionCounts:
    """Rolling-window counts for the calling session (this call excluded)."""

    sends: int = 0
    deletes: int = 0
    recent_error: bool = False
    window_tokens: int = 0


@dataclass
class ClassifierThresholds:
    external_comm_volume: int = 3
    bulk_delete_count: int = 5
    # TOKEN_BUDGET fires when session token use exceeds this. 0 disables (default).
    session_token_budget: int = 0


@dataclass
class ClassifierRules:
    thresholds: ClassifierThresholds = field(default_factory=ClassifierThresholds)
    tool_class_overrides: dict[str, AgentActionClass] = field(default_factory=dict)


DEFAULT_RULES = ClassifierRules()


@dataclass
class Classification:
    action_class: AgentActionClass
    decision: Decision
    triggers: list[StructuralTrigger]
    reasons: list[str]
    unknown_tool: bool


# ---------------------------------------------------------------------------
# Name-pattern base classes — mirrors NAME_RULES in classifier.ts exactly.
# NOTE: \b does not fire inside snake_case (underscore is a word character),
# so short tokens use explicit (^|[_\W])...([_\W]|$) boundaries instead.
# ---------------------------------------------------------------------------

@dataclass
class _NameRule:
    pattern: re.Pattern[str]
    cls: AgentActionClass
    reason: str
    trigger: str | None = None
    kind: str | None = None  # "send" | "delete" | "shell"


_NAME_RULES: list[_NameRule] = [
    _NameRule(
        re.compile(r"credential|secret|token|api[_-]?key|keychain|vault|dotenv|(^|[_\W])env([_\W]|$)", re.I),
        AgentActionClass.IRREVERSIBLE_HIGH,
        "tool name references credential/secret storage",
        trigger="CREDENTIAL_ACCESS",
    ),
    _NameRule(
        re.compile(r"billing|payment|charge|subscri|invoice|refund|payout|checkout", re.I),
        AgentActionClass.IRREVERSIBLE_HIGH,
        "tool name references billing/payment state",
        trigger="BILLING_MODIFICATION",
    ),
    _NameRule(
        re.compile(r"sudo|chmod|chown|setcap|escalat", re.I),
        AgentActionClass.IRREVERSIBLE_HIGH,
        "tool name references permission/capability change",
        trigger="PERMISSION_ESCALATION",
    ),
    _NameRule(
        re.compile(r"delete|remove|(^|[_\W])rm([_\W]|$)|drop|destroy|purge|truncate|wipe|erase", re.I),
        AgentActionClass.IRREVERSIBLE_MEDIUM,
        "tool name is a delete-class operation",
        kind="delete",
    ),
    _NameRule(
        re.compile(r"send|email|message|publish|tweet|(^|[_\W])dm([_\W]|$)|broadcast|outreach|reply|post_", re.I),
        AgentActionClass.IRREVERSIBLE_LOW,
        "tool name is an outbound communication",
        kind="send",
    ),
    _NameRule(
        re.compile(r"^(get|list|read|search|fetch|view|query|describe|stat|browse|find|check)[_-]?", re.I),
        AgentActionClass.REVERSIBLE,
        "tool name is a read-only operation",
    ),
    _NameRule(
        re.compile(r"write|create|update|edit|move|rename|upload|insert|append|save", re.I),
        AgentActionClass.REVERSIBLE,
        "tool name is a workspace write (operator-recoverable)",
    ),
    _NameRule(
        re.compile(r"shell|exec|bash|terminal|command|(^|[_\W])run([_\W]|$)|subprocess|script", re.I),
        AgentActionClass.REVERSIBLE,
        "tool name is a shell/exec surface — arguments inspected",
        kind="shell",
    ),
    _NameRule(
        re.compile(r"undo|revert|rollback|restore|cancel|halt|stop|abort|pause", re.I),
        AgentActionClass.RISK_REDUCING,
        "tool name reduces or undoes risk",
    ),
]


# ---------------------------------------------------------------------------
# Argument inspection — mirrors SHELL_PATTERNS (case-sensitive, as in TS).
# ---------------------------------------------------------------------------

@dataclass
class _ArgFinding:
    cls: AgentActionClass
    reason: str
    trigger: str | None = None


_SHELL_PATTERNS: list[tuple[re.Pattern[str], _ArgFinding]] = [
    (
        re.compile(r"\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+|--force|--recursive)"),
        _ArgFinding(AgentActionClass.IRREVERSIBLE_HIGH, "shell command contains recursive/forced rm", "BULK_DELETE"),
    ),
    (
        re.compile(r"\bsudo\b"),
        _ArgFinding(AgentActionClass.IRREVERSIBLE_HIGH, "shell command uses sudo", "PERMISSION_ESCALATION"),
    ),
    (
        re.compile(r"\b(chmod|chown|setcap)\b"),
        _ArgFinding(AgentActionClass.IRREVERSIBLE_HIGH, "shell command changes permissions/ownership", "PERMISSION_ESCALATION"),
    ),
    (
        re.compile(r"\b(curl|wget)\b[^|;&]*\|\s*(ba|z|da)?sh\b"),
        _ArgFinding(AgentActionClass.IRREVERSIBLE_HIGH, "shell command pipes a download into a shell", "PERMISSION_ESCALATION"),
    ),
    (
        re.compile(r"(^|[\s/\"'=])\.env\b|\bid_rsa\b|\.pem\b|secrets?[./]|credentials?[./]"),
        _ArgFinding(AgentActionClass.IRREVERSIBLE_HIGH, "shell command touches credential/secret files", "CREDENTIAL_ACCESS"),
    ),
    (
        re.compile(r"git\s+push\s[^|;&]*(--force|-f\b)"),
        _ArgFinding(AgentActionClass.IRREVERSIBLE_MEDIUM, "force-push rewrites remote history"),
    ),
]

# References to the governance layer itself (DISABLE_SAFEGUARDS): policy,
# audit chain + corpus, hold/session state, AND the phinq-governance skill.
# An agent must not quietly read, edit, or delete the rules that constrain it.
# Kept byte-for-byte equivalent to the TypeScript SAFEGUARD_PATHS regex.
_SAFEGUARD_PATHS = re.compile(
    r"phinq\.ya?ml|phinq\.env|phinq[-_]config|phinq[-_]toolcalls|phinq[-_]?audit"
    r"|audit.*\.jsonl|phinq[-_]holds|phinq[-_]session|phinq[-_]governance"
    r"|(^|[\s/\"'=([])\.phinq(?=[/\\\"'\s)\]]|$)",
    re.I,
)

# Argument keys that carry recipients for outbound communications.
_RECIPIENT_KEYS = ["to", "recipients", "emails", "cc", "bcc", "targets"]


def _count_recipients(args: dict[str, Any]) -> int:
    n = 0
    for key in _RECIPIENT_KEYS:
        v = args.get(key)
        if isinstance(v, list):
            n += len(v)
        elif isinstance(v, str) and v.strip():
            n += len([s for s in re.split(r"[,;]", v) if s.strip()])
    return n


def _count_items(args: dict[str, Any]) -> int:
    """Best-effort count of items a single call operates on (ids/paths/files arrays)."""
    mx = 0
    for v in args.values():
        if isinstance(v, list):
            mx = max(mx, len(v))
    return mx


def _all_strings(value: Any, out: list[str] | None = None, depth: int = 0) -> list[str]:
    if out is None:
        out = []
    if depth > 4:
        return out
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, list):
        for v in value:
            _all_strings(v, out, depth + 1)
    elif isinstance(value, dict):
        for v in value.values():
            _all_strings(v, out, depth + 1)
    return out


# ---------------------------------------------------------------------------
# The classifier
# ---------------------------------------------------------------------------

def classify_tool_call(
    name: str | None,
    arguments_json: str | None = None,
    session: SessionCounts | None = None,
    rules: ClassifierRules | None = None,
) -> Classification:
    """Classify one proposed tool call. Mirrors classifyToolCall() in TS."""
    session = session or SessionCounts()
    rules = rules or DEFAULT_RULES
    name = name or ""
    reasons: list[str] = []
    triggers: list[str] = []  # ordered set
    cls: AgentActionClass | None = None
    is_send = is_delete = is_shell = False

    def add_trigger(t: str) -> None:
        if t not in triggers:
            triggers.append(t)

    # 1. Name patterns — every matching rule applies, highest class wins.
    for rule in _NAME_RULES:
        if not rule.pattern.search(name):
            continue
        cls = rule.cls if cls is None else max_class(cls, rule.cls)
        if rule.trigger:
            add_trigger(rule.trigger)
        if rule.kind == "send":
            is_send = True
        elif rule.kind == "delete":
            is_delete = True
        elif rule.kind == "shell":
            is_shell = True
        reasons.append(rule.reason)

    # Operator override replaces the name-derived base class entirely.
    override = rules.tool_class_overrides.get(name)
    if override:
        cls = override
        reasons.append(f"operator override: {name} → {override.value}")

    # Unknown tool: flagged at IRREVERSIBLE_LOW (zero-false-HOLD posture).
    unknown = cls is None
    if cls is None:
        cls = AgentActionClass.IRREVERSIBLE_LOW
        reasons.append("unrecognized tool name — flagged for calibration")

    # 2. Argument inspection.
    args: dict[str, Any] | None = None
    if arguments_json:
        try:
            parsed = json.loads(arguments_json)
            if isinstance(parsed, dict):
                args = parsed
        except (ValueError, TypeError):
            pass  # unparseable args: stay at the name-derived class

    if args is not None:
        joined = "\n".join(_all_strings(args))

        if is_shell:
            for pattern, finding in _SHELL_PATTERNS:
                if pattern.search(joined):
                    cls = max_class(cls, finding.cls)
                    if finding.trigger:
                        add_trigger(finding.trigger)
                    reasons.append(finding.reason)

        if _SAFEGUARD_PATHS.search(joined):
            cls = AgentActionClass.IRREVERSIBLE_HIGH
            add_trigger("DISABLE_SAFEGUARDS")
            reasons.append("arguments reference Phinq governance files")

        if is_send:
            recipients = _count_recipients(args)
            if recipients > 1:
                cls = max_class(cls, AgentActionClass.IRREVERSIBLE_MEDIUM)
                reasons.append(f"outbound communication to {recipients} recipients")
            if recipients > rules.thresholds.external_comm_volume:
                cls = AgentActionClass.IRREVERSIBLE_HIGH
                add_trigger("EXTERNAL_COMM_VOLUME")
                reasons.append(f"single call exceeds {rules.thresholds.external_comm_volume} recipients")

        if is_delete:
            items = _count_items(args)
            if items > rules.thresholds.bulk_delete_count:
                cls = AgentActionClass.IRREVERSIBLE_HIGH
                add_trigger("BULK_DELETE")
                reasons.append(f"single call deletes {items} items")

    # 3. Session-window structural triggers.
    if is_send and session.sends + 1 > rules.thresholds.external_comm_volume:
        cls = AgentActionClass.IRREVERSIBLE_HIGH
        add_trigger("EXTERNAL_COMM_VOLUME")
        reasons.append(
            f"session send count {session.sends + 1} exceeds {rules.thresholds.external_comm_volume}"
        )
    if is_delete and session.deletes + 1 > rules.thresholds.bulk_delete_count:
        cls = AgentActionClass.IRREVERSIBLE_HIGH
        add_trigger("BULK_DELETE")
        reasons.append(
            f"session delete count {session.deletes + 1} exceeds {rules.thresholds.bulk_delete_count}"
        )
    if (
        rules.thresholds.session_token_budget > 0
        and session.window_tokens > rules.thresholds.session_token_budget
    ):
        cls = AgentActionClass.IRREVERSIBLE_HIGH
        add_trigger("TOKEN_BUDGET")
        reasons.append(
            f"session token use {session.window_tokens} exceeds budget {rules.thresholds.session_token_budget}"
        )
    if session.recent_error and ("BULK_DELETE" in triggers or "EXTERNAL_COMM_VOLUME" in triggers):
        add_trigger("AFTER_ERROR_BULK")
        reasons.append("bulk operation within the error window of a prior failure")

    # 4. Decision: MEDIUM and HIGH hold; structural triggers always hold.
    decision: Decision = (
        "HOLD"
        if triggers
        or cls in (AgentActionClass.IRREVERSIBLE_MEDIUM, AgentActionClass.IRREVERSIBLE_HIGH)
        else "ALLOW"
    )

    return Classification(
        action_class=cls,
        decision=decision,
        triggers=triggers,
        reasons=reasons,
        unknown_tool=unknown,
    )


def session_event_kind(name: str | None) -> str | None:
    """Whether a classified call counts as a send/delete for session windows."""
    if not name:
        return None
    for rule in _NAME_RULES:
        if rule.kind == "send" and rule.pattern.search(name):
            return "send"
        if rule.kind == "delete" and rule.pattern.search(name):
            return "delete"
    return None
