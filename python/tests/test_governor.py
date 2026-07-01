"""Governor gate semantics — mirrors sdk governor behavior."""
import time

from phinq import MemorySessionStore, PhinqGovernor, SessionWindows, session_key_from


def test_allow_passes_without_handler():
    g = PhinqGovernor()
    r = g.gate("read_file", {"path": "x.md"})
    assert r.allowed is True
    assert r.resolution == "allowed"


def test_hold_without_handler_uses_default_deny():
    g = PhinqGovernor()
    r = g.gate("delete_file", {"path": "x.md"})
    assert r.allowed is False
    assert r.resolution == "denied"


def test_hold_without_handler_default_approve():
    g = PhinqGovernor(default_on_hold="approve")
    r = g.gate("delete_file", {"path": "x.md"})
    assert r.allowed is True
    assert r.resolution == "approved"


def test_on_hold_approve_and_deny():
    g = PhinqGovernor()
    r = g.gate("delete_file", {"path": "x.md"}, on_hold=lambda req: "approve")
    assert r.allowed is True and r.resolution == "approved"
    r = g.gate("delete_file", {"path": "x.md"}, on_hold=lambda req: "deny")
    assert r.allowed is False and r.resolution == "denied"


def test_on_hold_timeout_denies():
    g = PhinqGovernor()

    def slow(req):
        time.sleep(1.0)
        return "approve"

    r = g.gate("delete_file", {"path": "x.md"}, on_hold=slow, hold_timeout_s=0.05)
    assert r.allowed is False
    assert r.resolution == "timed_out"


def test_velocity_accumulates_across_gates():
    g = PhinqGovernor()
    for _ in range(3):
        r = g.gate("send_message", {"to": "x@y.z"})
        assert r.allowed is True
    fourth = g.gate("send_message", {"to": "x@y.z"})
    assert fourth.allowed is False
    assert "EXTERNAL_COMM_VOLUME" in fourth.classification.triggers


def test_record_error_arms_after_error_bulk():
    g = PhinqGovernor()
    g.record_error()
    for _ in range(3):
        g.gate("send_message", {"to": "x@y.z"})
    r = g.gate("send_message", {"to": "x@y.z"})
    assert "AFTER_ERROR_BULK" in r.classification.triggers


def test_audit_hook_fires():
    events = []
    g = PhinqGovernor(on_audit=events.append)
    g.gate("read_file", {"path": "x.md"})
    g.gate("delete_file", {"path": "x.md"})
    assert len(events) == 2
    assert events[0].decision == "ALLOW"
    assert events[1].decision == "HOLD"
    assert events[1].allowed is False


def test_session_store_window_expiry():
    store = MemorySessionStore(SessionWindows(window_minutes=60, error_window_minutes=10))
    now = 1_000_000.0
    store.record("k", "send", now)
    store.record("k", "error", now)
    c = store.counts("k", now + 5 * 60)
    assert c.sends == 1 and c.recent_error is True
    c = store.counts("k", now + 11 * 60)
    assert c.sends == 1 and c.recent_error is False  # error window passed
    c = store.counts("k", now + 61 * 60)
    assert c.sends == 0


def test_session_key_is_hash():
    k = session_key_from("sk-secret-api-key")
    assert len(k) == 64
    assert "secret" not in k
