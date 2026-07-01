import { test } from "node:test";
import assert from "node:assert/strict";
import { HoldStore } from "../src/holds.js";
import { CompositeNotifier, SlackNotifier, type SlackConfig } from "../src/slack.js";

const nullLog = { info: () => {}, warn: () => {}, error: () => {} };

const cfg = (over: Partial<SlackConfig> = {}): SlackConfig => ({
  botToken: "xoxb-test",
  appToken: "xapp-test",
  channel: "C123",
  operatorIds: ["U_OP"],
  apiBase: "http://127.0.0.1:1", // never reached — api() is stubbed
  ...over,
});

/** SlackNotifier with the Web API transport stubbed out and recorded. */
class StubSlack extends SlackNotifier {
  calls: { method: string; payload: Record<string, unknown> }[] = [];
  protected override async api(
    method: string,
    payload: object
  ): Promise<Record<string, unknown> | null> {
    this.calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "chat.postMessage") return { ok: true, ts: "111.222" };
    return { ok: true };
  }
}

function makeHold(store: HoldStore) {
  return store.createAndWait({
    responseBody: Buffer.from("{}"),
    calls: [
      {
        function_name: "delete_file",
        action_class: "IRREVERSIBLE_MEDIUM",
        triggers: [],
        arguments: '{"path":"x"}',
      },
    ],
    timeoutMs: 60_000,
  });
}

function actionPayload(
  store: HoldStore,
  holdId: string,
  decision: "approve" | "deny",
  userId: string,
  tag?: string
): Record<string, unknown> {
  return {
    type: "block_actions",
    user: { id: userId },
    actions: [
      {
        action_id: decision === "approve" ? "phinq_approve" : "phinq_deny",
        value: `p:${holdId}:${decision === "approve" ? "a" : "d"}:${tag ?? store.callbackTag(holdId, decision)}`,
      },
    ],
  };
}

test("notifyHold posts approve/deny buttons with HMAC-tagged values", async () => {
  const store = new HoldStore(":memory:", nullLog);
  const slack = new StubSlack(cfg(), store, nullLog);
  const { id } = makeHold(store);
  await slack.notifyHold(store.get(id)!, 240);

  const post = slack.calls.find((c) => c.method === "chat.postMessage");
  assert.ok(post, "chat.postMessage sent");
  assert.equal(post!.payload.channel, "C123");
  const blocks = post!.payload.blocks as Record<string, unknown>[];
  const actions = blocks.find((b) => b.type === "actions")!;
  const elements = actions.elements as Record<string, unknown>[];
  assert.equal(elements.length, 2);
  assert.match(String(elements[0].value), new RegExp(`^p:${id}:a:[0-9a-f]{16}$`));
  assert.match(String(elements[1].value), new RegExp(`^p:${id}:d:[0-9a-f]{16}$`));
  store.close();
});

test("operator approve applies and releases the hold", async () => {
  const store = new HoldStore(":memory:", nullLog);
  const slack = new StubSlack(cfg(), store, nullLog);
  const { id, outcome } = makeHold(store);
  await slack.handleBlockActions(actionPayload(store, id, "approve", "U_OP"));
  assert.equal(await outcome, "APPROVED");
  assert.equal(store.get(id)!.decided_by, "slack:U_OP");
  store.close();
});

test("non-operator clicks are ignored when an allow-list is set", async () => {
  const store = new HoldStore(":memory:", nullLog);
  const slack = new StubSlack(cfg(), store, nullLog);
  const { id } = makeHold(store);
  await slack.handleBlockActions(actionPayload(store, id, "approve", "U_EVIL"));
  assert.equal(store.get(id)!.status, "PENDING");
  store.close();
});

test("any user may decide when no allow-list is configured", async () => {
  const store = new HoldStore(":memory:", nullLog);
  const slack = new StubSlack(cfg({ operatorIds: [] }), store, nullLog);
  const { id } = makeHold(store);
  await slack.handleBlockActions(actionPayload(store, id, "deny", "U_ANY"));
  assert.equal(store.get(id)!.status, "DENIED");
  assert.equal(store.get(id)!.decided_by, "slack:U_ANY");
  store.close();
});

test("HMAC mismatch is rejected", async () => {
  const store = new HoldStore(":memory:", nullLog);
  const slack = new StubSlack(cfg(), store, nullLog);
  const { id } = makeHold(store);
  await slack.handleBlockActions(actionPayload(store, id, "approve", "U_OP", "deadbeefdeadbeef"));
  assert.equal(store.get(id)!.status, "PENDING");
  store.close();
});

test("first decision wins across channels (composite fan-out)", async () => {
  const store = new HoldStore(":memory:", nullLog);
  const a = new StubSlack(cfg(), store, nullLog);
  const b = new StubSlack(cfg(), store, nullLog);
  const composite = new CompositeNotifier([a, b]);
  const { id } = makeHold(store);
  await composite.notifyHold(store.get(id)!, 240);
  assert.ok(a.calls.length > 0 && b.calls.length > 0, "both channels notified");

  await a.handleBlockActions(actionPayload(store, id, "approve", "U_OP"));
  await b.handleBlockActions(actionPayload(store, id, "deny", "U_OP"));
  assert.equal(store.get(id)!.status, "APPROVED"); // second click was a no-op
  store.close();
});

test("terminal transition edits the message and drops the buttons", async () => {
  const store = new HoldStore(":memory:", nullLog);
  const slack = new StubSlack(cfg(), store, nullLog);
  const { id } = makeHold(store);
  await slack.notifyHold(store.get(id)!, 240);
  store.decide(id, "approve", "slack:U_OP");
  await new Promise((r) => setTimeout(r, 20)); // let the async listener run

  const update = slack.calls.find((c) => c.method === "chat.update");
  assert.ok(update, "chat.update sent");
  assert.equal(update!.payload.ts, "111.222");
  const blocks = update!.payload.blocks as Record<string, unknown>[];
  assert.ok(!blocks.some((b) => b.type === "actions"), "buttons removed");
  store.close();
});
