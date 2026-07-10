"""Cross-engine parity contract, Python side.

Classifies every fixture in proxy/test/fixtures/parity-corpus.jsonl and
asserts the verdict equals proxy/test/fixtures/parity-expected.json — the
same two files the TypeScript suite (proxy/test/parity.test.ts) asserts
against. The expected file is generated ONLY from the TS engine
(`npm run parity:regen` in proxy/); if this test fails after an intentional
classifier change, mirror the change into python/src/phinq/classifier.py —
never hand-edit the expected file to make Python pass.

Skips (rather than fails) when the fixtures aren't present, so the published
sdist's test suite still runs outside the monorepo.
"""

import json
from pathlib import Path

import pytest

from phinq import SessionCounts, classify_tool_call

FIXTURES = Path(__file__).resolve().parents[2] / "proxy" / "test" / "fixtures"
CORPUS = FIXTURES / "parity-corpus.jsonl"
EXPECTED = FIXTURES / "parity-expected.json"

pytestmark = pytest.mark.skipif(
    not (CORPUS.exists() and EXPECTED.exists()),
    reason="parity fixtures only exist in the monorepo checkout",
)


def _load_cases():
    return [json.loads(line) for line in CORPUS.read_text().splitlines() if line.strip()]


def test_fixture_ids_match_expected():
    ids = [c["id"] for c in _load_cases()]
    expected = json.loads(EXPECTED.read_text())
    assert len(set(ids)) == len(ids), "fixture ids must be unique"
    assert sorted(ids) == sorted(expected.keys())


def test_python_classifier_matches_parity_contract():
    expected = json.loads(EXPECTED.read_text())
    diverged = []
    for c in _load_cases():
        s = c["session"]
        r = classify_tool_call(
            c["name"],
            c["arguments_json"],
            SessionCounts(
                sends=s["sends"],
                deletes=s["deletes"],
                recent_error=s["recent_error"],
                window_tokens=s["window_tokens"],
            ),
        )
        got = {
            "decision": r.decision,
            "action_class": r.action_class.value
            if hasattr(r.action_class, "value")
            else str(r.action_class),
            "triggers": sorted(r.triggers),
            "unknown_tool": r.unknown_tool,
        }
        if got != expected[c["id"]]:
            diverged.append((c["id"], got, expected[c["id"]]))
    assert not diverged, "engines diverged:\n" + "\n".join(
        f'  {i}: python={g} expected={e}' for i, g, e in diverged
    )
