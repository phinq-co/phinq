import type { HoldRecord, HoldStore } from "./holds.js";

/**
 * Component 4 — Telegram confirmation (PROXY-MVP.md, day 9–11).
 *
 * One message per held response, listing every tool call with its
 * classification and triggers, with inline Approve / Deny buttons that apply
 * atomically to the whole response.
 *
 * Authentication (spec decision #6):
 *  - only callbacks from `operator_chat_id` are honored;
 *  - callback_data carries an HMAC tag keyed on the per-install secret
 *    (format "p:<hold_id>:<a|d>:<hmac16>", within Telegram's 64-byte limit);
 *  - first decision wins — later clicks get "already approved/denied".
 *
 * Transport is long-polling getUpdates (the proxy is self-hosted on
 * localhost; webhooks would require a public URL). The bot token is used
 * only to build request URLs and is never logged.
 */

export interface TelegramConfig {
  botToken: string;
  operatorChatId: string;
  /** Override for tests (mock server). Default https://api.telegram.org */
  apiBase: string;
}

interface TelegramLogger {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
}

export class TelegramNotifier {
  private offset = 0;
  private running = false;

  constructor(
    private readonly config: TelegramConfig,
    private readonly holds: HoldStore,
    private readonly log: TelegramLogger
  ) {
    holds.addTransitionListener((hold) => {
      void this.reflectTransition(hold);
    });
  }

  private async api(method: string, payload: object): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.config.apiBase}/bot${this.config.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(35_000),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!body.ok) {
        this.log.warn({ method, description: body.description }, "telegram API error");
        return null;
      }
      return body.result as Record<string, unknown>;
    } catch (err) {
      this.log.warn({ method, err: String(err) }, "telegram request failed");
      return null;
    }
  }

  /** Send the hold notification. Returns the Telegram message id. */
  async notifyHold(hold: HoldRecord, timeoutSeconds: number): Promise<void> {
    const lines = [
      "\u{1F6D1} Phinq hold — approval required",
      "",
      ...hold.calls.flatMap((c, i) => {
        const triggers = c.triggers?.length ? `  ⚠ ${c.triggers.join(", ")}` : "";
        const args = (c.arguments ?? "").replace(/\s+/g, " ").slice(0, 200);
        // Plain-English "why" so the operator can decide without decoding the
        // trigger code. Show the most specific reason (the last rule to fire).
        const why = c.reasons?.length ? c.reasons[c.reasons.length - 1] : undefined;
        const line = [`${i + 1}. ${c.function_name ?? "?"} [${c.action_class ?? "?"}]${triggers}`];
        if (why) line.push(`   why: ${why}`);
        line.push(`   ${args}`);
        return line;
      }),
      "",
      `model: ${hold.model ?? "?"}`,
      `Approve releases the response to the agent. Expires in ${timeoutSeconds}s → auto-deny.`,
    ];
    const result = await this.api("sendMessage", {
      chat_id: this.config.operatorChatId,
      text: lines.join("\n"),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: this.callbackData(hold.id, "approve") },
            { text: "❌ Deny", callback_data: this.callbackData(hold.id, "deny") },
          ],
        ],
      },
    });
    const messageId = result?.message_id;
    if (typeof messageId === "number") {
      this.holds.setTelegramMessageId(hold.id, messageId);
    }
  }

  private callbackData(holdId: string, decision: "approve" | "deny"): string {
    return `p:${holdId}:${decision === "approve" ? "a" : "d"}:${this.holds.callbackTag(holdId, decision)}`;
  }

  /** Edit the hold message to reflect a terminal state (buttons removed). */
  private async reflectTransition(hold: HoldRecord): Promise<void> {
    if (hold.telegram_message_id === undefined || hold.status === "PENDING") return;
    const suffix: Record<string, string> = {
      APPROVED: "✅ Approved — response released to the agent.",
      DENIED: "❌ Denied — agent received a denial and continues.",
      EXPIRED_TIMEOUT: "⏱ Expired — no decision in time; auto-denied.",
      EXPIRED_CLIENT:
        "\u{1F50C} Client disconnected before a decision — the action was NOT executed.",
    };
    await this.api("editMessageText", {
      chat_id: this.config.operatorChatId,
      message_id: hold.telegram_message_id,
      text: `Phinq hold ${hold.id}\n${suffix[hold.status] ?? hold.status}`,
    });
  }

  /** Long-poll getUpdates for operator button presses. */
  start(): void {
    this.running = true;
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const result = await this.api("getUpdates", {
        offset: this.offset,
        timeout: 25,
        allowed_updates: ["callback_query"],
      });
      if (!this.running) return;
      if (result === null) {
        await new Promise((r) => setTimeout(r, 5_000)); // backoff on errors
        continue;
      }
      const updates = (Array.isArray(result) ? result : []) as Record<string, unknown>[];
      for (const update of updates) {
        const updateId = update.update_id;
        if (typeof updateId === "number") this.offset = updateId + 1;
        const cb = update.callback_query as Record<string, unknown> | undefined;
        if (cb) await this.handleCallback(cb);
      }
    }
  }

  /** Exposed for tests: process one callback_query object. */
  async handleCallback(cb: Record<string, unknown>): Promise<void> {
    const callbackId = cb.id as string;
    const from = cb.from as Record<string, unknown> | undefined;
    const answer = (text: string) =>
      this.api("answerCallbackQuery", { callback_query_id: callbackId, text });

    // Only the operator's chat is honored; anything else is ignored silently
    // (answered without effect so the button doesn't spin forever).
    if (String(from?.id) !== String(this.config.operatorChatId)) {
      this.log.warn({ from_id: from?.id }, "callback from non-operator ignored");
      await answer("Not authorized.");
      return;
    }

    const match = /^p:([A-Za-z0-9_-]+):(a|d):([0-9a-f]{16})$/.exec(String(cb.data ?? ""));
    if (!match) {
      await answer("Malformed callback.");
      return;
    }
    const [, holdId, code, tag] = match;
    const decision = code === "a" ? "approve" : "deny";
    if (tag !== this.holds.callbackTag(holdId, decision)) {
      this.log.warn({ hold_id: holdId }, "callback HMAC mismatch — ignored");
      await answer("Invalid signature.");
      return;
    }

    const result = this.holds.decide(holdId, decision, `telegram:${String(from?.id)}`);
    switch (result.result) {
      case "applied":
        await answer(decision === "approve" ? "Approved." : "Denied.");
        break;
      case "already":
        await answer(`Already ${result.status === "APPROVED" ? "approved" : "denied"}.`);
        break;
      case "late":
        await answer(
          result.status === "EXPIRED_CLIENT"
            ? "Arrived late — the agent disconnected; the action was not executed."
            : "Arrived late — the hold expired; the action was not executed."
        );
        break;
      default:
        await answer("Unknown hold.");
    }
  }
}
