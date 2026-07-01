"""phinq — the runtime checkpoint for AI agents.

Deterministic tool-call risk classification, human-in-the-loop gating, and
audit hooks. Mirrors the TypeScript engine used by the Phinq proxy.
"""
from .classifier import (
    AgentActionClass,
    Classification,
    ClassifierRules,
    ClassifierThresholds,
    SessionCounts,
    classify_tool_call,
    max_class,
    session_event_kind,
)
from .governor import (
    AuditEvent,
    GateResult,
    HoldRequest,
    MemorySessionStore,
    PhinqGovernor,
    SessionWindows,
    session_key_from,
)

__version__ = "0.1.0"

__all__ = [
    "AgentActionClass",
    "AuditEvent",
    "Classification",
    "ClassifierRules",
    "ClassifierThresholds",
    "GateResult",
    "HoldRequest",
    "MemorySessionStore",
    "PhinqGovernor",
    "SessionCounts",
    "SessionWindows",
    "classify_tool_call",
    "max_class",
    "session_event_kind",
    "session_key_from",
]
