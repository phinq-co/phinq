"""In-process gate for tool execution — Python port of sdk/src/governor.ts.

    from phinq import PhinqGovernor

    governor = PhinqGovernor()
    result = governor.gate("delete_file", {"path": "/tmp/x"},
                           on_hold=lambda req: input(f"approve {req.name}? ") or "deny")
    if result.allowed:
        run_tool()

Unlike the proxy (which intercepts the model's *proposed* call), `gate()` sits
at the point of execution — the last line of defense before a side effect.
"""
from __future__ import annotations

import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from typing import Any, Callable

from .classifier import (
    Classification,
    ClassifierRules,
    DEFAULT_RULES,
    SessionCounts,
    classify_tool_call,
    session_event_kind,
)


@dataclass
class SessionWindows:
    """Rolling-window sizes (minutes) for velocity triggers."""

    window_minutes: int = 60
    error_window_minutes: int = 10


class MemorySessionStore:
    """In-memory rolling-window counters, keyed by session.

    `counts()` returns the window state BEFORE the current call, matching the
    classifier's contract (thresholds compare against prior activity).
    """

    def __init__(self, windows: SessionWindows | None = None) -> None:
        self.windows = windows or SessionWindows()
        self._events: dict[str, list[tuple[str, float]]] = {}

    def record(self, key: str, kind: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        self._events.setdefault(key, []).append((kind, now))
        self._prune(key, now)

    def counts(self, key: str, now: float | None = None) -> SessionCounts:
        now = time.time() if now is None else now
        self._prune(key, now)
        window_start = now - self.windows.window_minutes * 60
        error_start = now - self.windows.error_window_minutes * 60
        sends = deletes = 0
        recent_error = False
        for kind, ts in self._events.get(key, []):
            if kind == "send" and ts >= window_start:
                sends += 1
            elif kind == "delete" and ts >= window_start:
                deletes += 1
            elif kind == "error" and ts >= error_start:
                recent_error = True
        return SessionCounts(sends=sends, deletes=deletes, recent_error=recent_error)

    def _prune(self, key: str, now: float) -> None:
        longest = max(self.windows.window_minutes, self.windows.error_window_minutes)
        cutoff = now - longest * 60
        kept = [(k, t) for k, t in self._events.get(key, []) if t >= cutoff]
        if kept:
            self._events[key] = kept
        else:
            self._events.pop(key, None)


def session_key_from(identifier: str) -> str:
    """Hash an opaque session identifier — never store it raw."""
    return hashlib.sha256(identifier.encode()).hexdigest()


@dataclass
class HoldRequest:
    name: str
    args: Any
    classification: Classification
    session_key: str


@dataclass
class GateResult:
    allowed: bool
    decision: str
    classification: Classification
    resolution: str  # "allowed" | "approved" | "denied" | "timed_out"


@dataclass
class AuditEvent:
    ts: str
    name: str
    action_class: str
    decision: str
    triggers: list[str]
    allowed: bool
    resolution: str
    args_bytes: int


def _serialize_args(args: Any) -> str | None:
    if args is None:
        return None
    if isinstance(args, str):
        return args
    try:
        return json.dumps(args)
    except (TypeError, ValueError):
        return None


class PhinqGovernor:
    """Deterministic classifier + rolling-window velocity + human-in-the-loop gate."""

    def __init__(
        self,
        rules: ClassifierRules | None = None,
        windows: SessionWindows | None = None,
        default_on_hold: str = "deny",
        hold_timeout_s: float = 240.0,
        on_audit: Callable[[AuditEvent], None] | None = None,
    ) -> None:
        self.rules = rules or DEFAULT_RULES
        self.sessions = MemorySessionStore(windows)
        self.default_on_hold = default_on_hold
        self.hold_timeout_s = hold_timeout_s
        self.on_audit = on_audit

    def classify(self, name: str, args: Any = None, session_key: str = "default") -> Classification:
        return classify_tool_call(
            name, _serialize_args(args), self.sessions.counts(session_key), self.rules
        )

    def record_error(self, session_key: str = "default") -> None:
        """Mark a failure in this session — arms the AFTER_ERROR_BULK trigger."""
        self.sessions.record(session_key, "error")

    def gate(
        self,
        name: str,
        args: Any = None,
        *,
        session_key: str = "default",
        on_hold: Callable[[HoldRequest], str] | None = None,
        hold_timeout_s: float | None = None,
    ) -> GateResult:
        """Classify and gate one tool execution.

        `on_hold` receives a HoldRequest and returns "approve" or "deny".
        It runs with a timeout; no answer in time means deny ("timed_out").
        """
        args_json = _serialize_args(args)
        classification = classify_tool_call(
            name, args_json, self.sessions.counts(session_key), self.rules
        )

        kind = session_event_kind(name)
        if kind:
            self.sessions.record(session_key, kind)

        if classification.decision == "ALLOW":
            allowed, resolution = True, "allowed"
        elif on_hold is None:
            allowed = self.default_on_hold == "approve"
            resolution = "approved" if allowed else "denied"
        else:
            req = HoldRequest(name=name, args=args, classification=classification, session_key=session_key)
            timeout = self.hold_timeout_s if hold_timeout_s is None else hold_timeout_s
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(on_hold, req)
                try:
                    verdict = future.result(timeout=timeout)
                except FutureTimeout:
                    verdict = None
                except Exception:
                    verdict = None
            if verdict == "approve":
                allowed, resolution = True, "approved"
            elif verdict == "deny":
                allowed, resolution = False, "denied"
            else:
                allowed, resolution = False, "timed_out"

        result = GateResult(
            allowed=allowed,
            decision=classification.decision,
            classification=classification,
            resolution=resolution,
        )
        if self.on_audit:
            self.on_audit(
                AuditEvent(
                    ts=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    name=name,
                    action_class=classification.action_class.value,
                    decision=classification.decision,
                    triggers=list(classification.triggers),
                    allowed=allowed,
                    resolution=resolution,
                    args_bytes=len(args_json) if args_json else 0,
                )
            )
        return result
