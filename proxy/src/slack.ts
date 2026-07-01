import type { HoldRecord, HoldStore } from "./holds.js";

/**
 * Slack approval channel — the team-facing sibling of telegram.ts.
 *
 * One message per held response in a configured channel, with Approve / Deny
 * buttons that apply atomically to the whole response. Same security posture
 * as Telegram:
 *  - button `value` carries an HMAC tag keyed on the per-install secret
 *    (format "p:<hold_id>:<a|d>:<hmac16>");
 *  - decisions are honored only from the configured operator user IDs
 *    (when set — otherwise any workspace user who can see the channel);
 *  - first decision wins — later clicks get "already approved/denied".
 *
 * Transport is Socket Mode (WebSocket via apps.connections.open) so the
 * self-hosted proxy needs no public Request URL — the Slack analog of
 * Telegram's long-polling. Requires a bot token (xoxb-…) for Web API calls
 * and an app-level token (xapp-…) with `connections:write` for the socket.
 * Tokens are used only to authorize requests and are never logged.
 */

export interface SlackConfig {
  botToken: string;
  appToken: string;
  channel: string;
  /** Comma-separated Slack user IDs allowed to decide. Empty = any user. */
  operatorIds: string[];
  /** Override for tests. Default https://slack.com/api */
  apiBase: string;
}

interface SlackLogger {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
}

/** Common surface for approval channels (Telegram, Slack, …). */
export interface HoldNotifier {
  notifyHold(hold: HoldRecord, timeoutSeconds: number): Promise<void>;
  start(): void;
  stop(): void;
}

/** Fan a hold out to several channels; first decision anywhere wins. */
export class CompositeNotifier implements HoldNotifier {
  constructor(private readonly notifiers: HoldNotifier[]) {}
  async notifyHold(hold: HoldRecord, timeoutSeconds: number): Promise<void> {
    await Promise.all(this.notifiers.map((n) => n.notifyHold(hold, timeoutSeconds)));
  }
  start(): void {
    for (const n of this.notifiers) n.start();
  }
  stop(): void {
    for (const n of this.notifiers) n.stop();
  }
}

export class SlackNotifier implements HoldNotifier {
  private running = false;
  private ws: WebSocket | null = null;
  /** hold id → message ts, for editing the message on terminal transitions. */
  private readonly messageTs = new Map<string, string>();

  constructor(
    private readonly config: SlackConfig,
    private readonly holds: HoldStore,
    private readonly log: SlackLogger
  ) {
    holds.addTransitionListener((hold) => {
      void this.reflectTransition(hold);
    });
  }

  /** Slack Web API call. Protected so tests can stub the transport. */
  protected async api(
    method: string,
    payload: object,
    token: string = this.config.botToken
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.config.apiBase}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!body.ok) {
        this.log.warn({ method, error: body.error }, "slack API error");
        return null;
      }
      return body;
    } catch (err) {
      this.log.warn({ method, err: String(err) }, "slack request failed");
      return null;
    }
  }

  async notifyHold(hold: HoldRecord, timeoutSeconds: number): Promise<void> {
    const callLines = hold.calls
      .map((c, i) => {
        const triggers = c.triggers?.length ? `  ⚠ ${c.triggers.join(", ")}` : "";
        const args = (c.arguments ?? "").replace(/\s+/g, " ").slice(0, 200);
        return `${i + 1}. *${c.function_name ?? "?"}* \`${c.action_class ?? "?"}\`${triggers}\n    \`${args}\``;
      })
      .join("\n");
    const result = await this.api("chat.postMessage", {
      channel: this.config.channel,
      text: `Phinq hold — approval required (${hold.id})`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:octagonal_sign: *Phinq hold — approval required*\n${callLines}\n\nmodel: \`${hold.model ?? "?"}\` · expires in ${timeoutSeconds}s → auto-deny`,
          },
        },
        {
          type: "actions",
          block_id: `phinq_hold_${hold.id}`,
          elements: [
            {
              type: "button",
              style: "primary",
              text: { type: "plain_text", text: "Approve" },
              action_id: "phinq_approve",
              value: this.buttonValue(hold.id, "approve"),
            },
            {
              type: "button",
              style: "danger",
              text: { type: "plain_text", text: "Deny" },
              action_id: "phinq_deny",
              value: this.buttonValue(hold.id, "deny"),
            },
          ],
        },
      ],
    });
    const ts = result?.ts;
    if (typeof ts === "string") this.messageTs.set(hold.id, ts);
  }

  private buttonValue(holdId: string, decision: "approve" | "deny"): string {
    return `p:${holdId}:${decision === "approve" ? "a" : "d"}:${this.holds.callbackTag(holdId, decision)}`;
  }

  /** Edit the hold message to a terminal state (buttons removed). */
  private async reflectTransition(hold: HoldRecord): Promise<void> {
    const ts = this.messageTs.get(hold.id);
    if (!ts || hold.status === "PENDING") return;
    const suffix: Record<string, string> = {
      APPROVED: ":white_check_mark: Approved — response released to the agent.",
      DENIED: ":x: Denied — agent received a denial and continues.",
      EXPIRED_TIMEOUT: ":hourglass: Expired — no decision in time; auto-denied.",
      EXPIRED_CLIENT: ":electric_plug: Client disconnected before a decision — the action was NOT executed.",
    };
    await this.api("chat.update", {
      channel: this.config.channel,
      ts,
      text: `Phinq hold ${hold.id} — ${hold.status}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `Phinq hold \`${hold.id}\`\n${suffix[hold.status] ?? hold.status}` },
        },
      ],
    });
    this.messageTs.delete(hold.id);
  }

  /** Open the Socket Mode connection and process interactive payloads. */
  start(): void {
    this.running = true;
    void this.socketLoop();
  }

  stop(): void {
    this.running = false;
    this.ws?.close();
    this.ws = null;
  }

  private async socketLoop(): Promise<void> {
    while (this.running) {
      const opened = await this.api("apps.connections.open", {}, this.config.appToken);
      const url = opened?.url;
      if (typeof url !== "string") {
        await new Promise((r) => setTimeout(r, 10_000)); // backoff and retry
        continue;
      }
      try {
        await this.runSocket(url);
      } catch (err) {
        this.log.warn({ err: String(err) }, "slack socket error — reconnecting");
      }
      if (this.running) await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  private runSocket(url: string): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("message", (event) => {
        void (async () => {
          let envelope: Record<string, unknown>;
          try {
            envelope = JSON.parse(String(event.data)) as Record<string, unknown>;
          } catch {
            return;
          }
          // Ack immediately — Slack requires it within 3 seconds.
          if (typeof envelope.envelope_id === "string") {
            ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          }
          if (envelope.type === "disconnect") {
            ws.close();
            return;
          }
          if (envelope.type === "interactive") {
            const payload = envelope.payload as Record<string, unknown> | undefined;
            if (payload?.type === "block_actions") await this.handleBlockActions(payload);
          }
        })();
      });
      ws.addEventListener("close", () => {
        if (this.ws === ws) this.ws = null;
        resolve();
      });
      ws.addEventListener("error", () => ws.close());
    });
  }

  /** Exposed for tests: process one block_actions payload. */
  async handleBlockActions(payload: Record<string, unknown>): Promise<void> {
    const user = payload.user as Record<string, unknown> | undefined;
    const userId = String(user?.id ?? "");
    const actions = (payload.actions as Record<string, unknown>[] | undefined) ?? [];
    const responseUrl = typeof payload.response_url === "string" ? payload.response_url : null;

    // Ephemeral feedback to the clicking user via response_url (no token needed).
    const respond = async (text: string) => {
      if (!responseUrl) return;
      try {
        await fetch(responseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, response_type: "ephemeral", replace_original: false }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        /* feedback is best-effort */
      }
    };

    if (this.config.operatorIds.length > 0 && !this.config.operatorIds.includes(userId)) {
      this.log.warn({ user_id: userId }, "slack action from non-operator ignored");
      await respond("Not authorized.");
      return;
    }

    for (const action of actions) {
      if (action.action_id !== "phinq_approve" && action.action_id !== "phinq_deny") continue;
      const match = /^p:([A-Za-z0-9_-]+):(a|d):([0-9a-f]{16})$/.exec(String(action.value ?? ""));
      if (!match) {
        await respond("Malformed action.");
        continue;
      }
      const [, holdId, code, tag] = match;
      const decision = code === "a" ? "approve" : "deny";
      if (tag !== this.holds.callbackTag(holdId, decision)) {
        this.log.warn({ hold_id: holdId }, "slack action HMAC mismatch — ignored");
        await respond("Invalid signature.");
        continue;
      }
      const result = this.holds.decide(holdId, decision, `slack:${userId}`);
      switch (result.result) {
        case "applied":
          await respond(decision === "approve" ? "Approved." : "Denied.");
          break;
        case "already":
          await respond(`Already ${result.status === "APPROVED" ? "approved" : "denied"}.`);
          break;
        case "late":
          await respond(
            result.status === "EXPIRED_CLIENT"
              ? "Arrived late — the agent disconnected; the action was not executed."
              : "Arrived late — the hold expired; the action was not executed."
          );
          break;
        default:
          await respond("Unknown hold.");
      }
    }
  }
}
