"""Guardrail behavior — tested without litellm installed (duck-typed responses)."""
import asyncio
import json

import pytest

from phinq.litellm_guardrail import PhinqGuardrail, PhinqHoldError


def response_with_tool_calls(*calls):
    """OpenAI-shaped dict response, as LiteLLM hands to post-call hooks."""
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": f"c{i}",
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)},
                        }
                        for i, (name, args) in enumerate(calls)
                    ],
                }
            }
        ]
    }


def test_safe_response_passes():
    g = PhinqGuardrail()
    resp = response_with_tool_calls(("read_file", {"path": "notes.md"}))
    out = asyncio.run(g.async_post_call_success_hook({}, None, resp))
    assert out is resp


def test_no_tool_calls_passes():
    g = PhinqGuardrail()
    resp = {"choices": [{"message": {"role": "assistant", "content": "hi"}}]}
    out = asyncio.run(g.async_post_call_success_hook({}, None, resp))
    assert out is resp


def test_hold_blocks_when_enforcing():
    g = PhinqGuardrail(enforce=True)
    resp = response_with_tool_calls(("delete_file", {"path": "/data"}))
    with pytest.raises(PhinqHoldError) as e:
        asyncio.run(g.async_post_call_success_hook({}, None, resp))
    assert "delete_file" in str(e.value)
    assert "IRREVERSIBLE_MEDIUM" in str(e.value)


def test_shadow_mode_logs_but_passes():
    g = PhinqGuardrail(enforce=False)
    resp = response_with_tool_calls(("shell_exec", {"cmd": "sudo rm -rf /"}))
    out = asyncio.run(g.async_post_call_success_hook({}, None, resp))
    assert out is resp


def test_check_response_reports_triggers():
    g = PhinqGuardrail()
    resp = response_with_tool_calls(("read_env_file", {}))
    holds = g.check_response(resp)
    assert len(holds) == 1
    assert holds[0]["tool"] == "read_env_file"
    assert "CREDENTIAL_ACCESS" in holds[0]["triggers"]


def test_velocity_accumulates_per_session():
    g = PhinqGuardrail()
    for _ in range(3):
        assert g.check_response(response_with_tool_calls(("send_email", {"to": "a@x.co"}))) == []
    holds = g.check_response(response_with_tool_calls(("send_email", {"to": "a@x.co"})))
    assert len(holds) == 1
    assert "EXTERNAL_COMM_VOLUME" in holds[0]["triggers"]


def test_mixed_calls_reports_only_holds():
    g = PhinqGuardrail()
    resp = response_with_tool_calls(
        ("read_file", {"path": "x"}),
        ("update_subscription", {"plan": "pro"}),
    )
    holds = g.check_response(resp)
    assert [h["tool"] for h in holds] == ["update_subscription"]


def test_token_budget_enforced_via_guardrail():
    from phinq import ClassifierRules, ClassifierThresholds

    g = PhinqGuardrail(rules=ClassifierRules(thresholds=ClassifierThresholds(session_token_budget=8000)))
    resp = response_with_tool_calls(("read_file", {"path": "x"}))
    resp["usage"] = {"prompt_tokens": 5000, "completion_tokens": 100, "total_tokens": 5100}
    assert g.check_response(resp) == []  # 5,100 tokens — under budget
    holds = g.check_response(resp)       # 10,200 — over budget: even safe calls hold
    assert len(holds) == 1
    assert "TOKEN_BUDGET" in holds[0]["triggers"]
