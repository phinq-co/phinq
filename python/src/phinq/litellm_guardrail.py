"""Phinq guardrail for the LiteLLM proxy/gateway.

Runs the deterministic Phinq classifier over every tool call the model
proposes, and blocks (or just logs, in shadow mode) responses that contain
actions Phinq would HOLD — bulk deletes, credential access, permission
escalation, billing changes, comms-volume blasts, and the rest of the
structural triggers.

Usage (LiteLLM `config.yaml`):

    guardrails:
      - guardrail_name: phinq
        litellm_params:
          guardrail: phinq.litellm_guardrail.PhinqGuardrail
          mode: post_call            # inspect the model's proposed tool calls
          enforce: true              # false = shadow mode (log only)

`pip install phinq` on the LiteLLM host is the only requirement. The
classifier is pure and in-process — no network calls, no added latency
beyond microseconds.

For hold-for-human-approval semantics (Telegram/Slack buttons, timeouts,
hash-chained audit) run the full Phinq proxy between LiteLLM and the
provider instead — see docs/litellm.md in the Phinq repo.
"""
from __future__ import annotations

import logging
from typing import Any

from .classifier import ClassifierRules, classify_tool_call, session_event_kind
from .governor import MemorySessionStore, session_key_from

logger = logging.getLogger("phinq.litellm")

try:  # pragma: no cover — exercised only when litellm is installed
    from litellm.integrations.custom_guardrail import CustomGuardrail as _Base
except ImportError:  # allows import (and testing) without litellm present
    _Base = object  # type: ignore[assignment,misc]


class PhinqHoldError(ValueError):
    """Raised when enforcement is on and a proposed tool call classifies HOLD."""


def _usage_tokens_from_response(response: Any) -> int:
    """Total tokens from a response usage block (OpenAI or Anthropic field names)."""
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    if usage is None:
        return 0
    get = (lambda k: getattr(usage, k, None)) if not isinstance(usage, dict) else usage.get
    num = lambda v: v if isinstance(v, (int, float)) and v > 0 else 0
    total = num(get("total_tokens"))
    if not total:
        total = (num(get("prompt_tokens")) or num(get("input_tokens"))) + (
            num(get("completion_tokens")) or num(get("output_tokens"))
        )
    return int(total)


def _tool_calls_from_response(response: Any) -> list[tuple[str, str | None]]:
    """Extract (name, arguments_json) pairs from a LiteLLM ModelResponse or dict."""
    out: list[tuple[str, str | None]] = []
    choices = getattr(response, "choices", None)
    if choices is None and isinstance(response, dict):
        choices = response.get("choices")
    for choice in choices or []:
        message = getattr(choice, "message", None)
        if message is None and isinstance(choice, dict):
            message = choice.get("message")
        if message is None:
            continue
        tool_calls = getattr(message, "tool_calls", None)
        if tool_calls is None and isinstance(message, dict):
            tool_calls = message.get("tool_calls")
        for tc in tool_calls or []:
            fn = getattr(tc, "function", None)
            if fn is None and isinstance(tc, dict):
                fn = tc.get("function")
            if fn is None:
                continue
            name = getattr(fn, "name", None)
            if name is None and isinstance(fn, dict):
                name = fn.get("name")
            args = getattr(fn, "arguments", None)
            if args is None and isinstance(fn, dict):
                args = fn.get("arguments")
            if name:
                out.append((str(name), args if isinstance(args, str) else None))
    return out


class PhinqGuardrail(_Base):  # type: ignore[misc,valid-type]
    """LiteLLM CustomGuardrail running Phinq's deterministic risk classifier.

    kwargs (via litellm_params):
        enforce: bool = True   — False logs HOLDs without blocking (shadow mode)
        rules:  ClassifierRules — optional threshold/override tuning
    """

    def __init__(self, enforce: bool = True, rules: ClassifierRules | None = None, **kwargs: Any):
        self.enforce = enforce
        self.rules = rules
        self.sessions = MemorySessionStore()
        if _Base is not object:  # pass through litellm's own kwargs
            super().__init__(**kwargs)  # type: ignore[call-arg]

    def check_response(self, response: Any, session_key: str = "default") -> list[dict[str, Any]]:
        """Classify every proposed tool call; return the HOLD verdicts."""
        holds: list[dict[str, Any]] = []
        tokens = _usage_tokens_from_response(response)
        if tokens:
            self.sessions.record_tokens(session_key, tokens)
        for name, args_json in _tool_calls_from_response(response):
            c = classify_tool_call(name, args_json, self.sessions.counts(session_key), self.rules)
            kind = session_event_kind(name)
            if kind:
                self.sessions.record(session_key, kind)
            if c.decision == "HOLD":
                holds.append(
                    {
                        "tool": name,
                        "action_class": c.action_class.value,
                        "triggers": list(c.triggers),
                        "reasons": list(c.reasons),
                    }
                )
        return holds

    async def async_post_call_success_hook(
        self, data: dict, user_api_key_dict: Any = None, response: Any = None
    ) -> Any:
        """LiteLLM post-call hook: inspect the model's proposed tool calls."""
        api_key = getattr(user_api_key_dict, "api_key", None) or ""
        session_key = session_key_from(api_key) if api_key else "default"
        holds = self.check_response(response, session_key)
        if not holds:
            return response
        summary = "; ".join(
            f"{h['tool']} [{h['action_class']}]"
            + (f" triggers={','.join(h['triggers'])}" if h["triggers"] else "")
            for h in holds
        )
        if self.enforce:
            logger.warning("phinq guardrail BLOCKED response: %s", summary)
            raise PhinqHoldError(
                f"Phinq guardrail: {len(holds)} proposed tool call(s) classified HOLD — {summary}. "
                "Route this model through the Phinq proxy for human approval instead of a hard block."
            )
        logger.warning("phinq guardrail (shadow) would HOLD: %s", summary)
        return response
