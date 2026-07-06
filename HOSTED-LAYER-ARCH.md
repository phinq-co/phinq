# Phinq Hosted Layer — Architecture

**Status:** design, pre-build (waitlist at phinq.co). Working doc, not marketing.
**Premise:** the OSS proxy stays the enforcement point on the customer's own
box. The hosted layer is a *control plane* — dashboards, team approvals,
anomaly detection, cross-agent audit — that never becomes a single point of
failure for enforcement. The proxy must keep governing if the cloud vanishes.

The non-negotiable inherited from the OSS design: **the audit chain's integrity
must not depend on trusting the cloud.** Everything below is shaped by that.

---

## 0. Trust model (read this first — it constrains every section)

Three principals, deliberately separated:

| Principal | Is | Authenticates with | Can |
|---|---|---|---|
| **Operator** | a human on a team | OAuth (SSO) → short-lived session JWT | approve/deny holds, read audit, manage team |
| **Proxy instance** | one OSS proxy process | long-lived **instance token** (issued at registration) | push events, pull decisions for *its* tenant only |
| **Agent** | the governed LLM app | *nothing new* — it authenticates to the **proxy** with its existing upstream key, exactly as today | never talks to the cloud directly |

Key decision: **agents never authenticate to the cloud.** The proxy is the only
thing the cloud knows about. This keeps the OSS security property intact (the
agent's provider key stays local, never touches Phinq servers) and means
"multi-tenant agent auth" simply doesn't exist as a problem — there is only
proxy-instance auth.

---

## 1. Auth model

### Operators
- **OAuth via a hosted IdP** (GitHub + Google to start; SAML later for
  enterprise). No Phinq-managed passwords — we never want to hold a credential
  that can approve a destructive action.
- OAuth → short-lived (15 min) session JWT, refresh rotated. The JWT carries
  `tenant_id` + `role` (owner / approver / viewer).
- **Approver role is the security boundary that matters** — only it can
  resolve holds. Viewers see everything, touch nothing.

### Proxy instances
- Registration (see §5) issues an **instance token**: `pht_<tenant>_<random>`,
  stored server-side as a hash. Scoped to exactly one `tenant_id`.
- Every proxy→cloud call carries it as `Authorization: Bearer`. The cloud
  derives `tenant_id` from the token — **the proxy cannot assert its own
  tenant**, closing the obvious spoofing hole.
- Rotatable and revocable from the dashboard; revocation is immediate
  (token-hash lookup on every request, cached ≤30s).

### Multi-tenant isolation
- `tenant_id` on **every** row; every query filtered by the token/JWT-derived
  tenant. Enforced at the data-access layer, not per-handler (a handler that
  forgets the filter should fail closed).
- Postgres **row-level security** as defense-in-depth: `SET app.tenant_id`
  per connection; policies reject cross-tenant reads even if a query is
  malformed. Belt and suspenders because the blast radius of a leak here is
  "Tenant A sees Tenant B's held `delete_production_database`."
- Object storage (audit blobs) keyed `s3://…/<tenant_id>/…` with IAM scoped
  per-tenant prefix.

---

## 2. Data flow

```
   ┌─────────┐   existing upstream key   ┌──────────────┐
   │  Agent  │ ────────────────────────▶ │  OSS Proxy   │ ──▶ LLM upstream
   └─────────┘   (never talks to cloud)  │  (customer)  │
                                          └──────┬───────┘
                        outbound-only, mTLS      │  (proxy dials out;
                        WebSocket + HTTPS        ▼   nothing dials in)
                                          ┌──────────────┐
                                          │ Phinq Cloud  │
                                          │ control plane│
                                          └──────┬───────┘
                                                 ▼
                                          ┌──────────────┐
                                          │  Dashboard   │  operators (OAuth)
                                          └──────────────┘
```

### Push, not pull
The proxy **pushes** outbound; the cloud never dials into the customer network.
This is the only design that works behind NAT/firewalls (§5) and it keeps the
customer's attack surface at zero inbound ports.

### What the proxy sends — tiered, operator-configurable
1. **Held actions** (real-time, always): the pending hold — tool name, class,
   triggers, reasons, args_bytes, `hold_id`. Needed for the approval UI.
2. **Audit records** (near-real-time batch): the chain entries as written
   (decision/usage/hold_transition/policy_change) **with their hashes**.
3. **Corpus / arguments** (opt-in, off by default): the actual tool-call
   arguments. Default off preserves the OSS "payloads stay local" property;
   a team that *wants* rich dashboards opts in explicitly and knowingly.

Default posture = "held actions + audit metadata," i.e. enough to approve and
to prove oversight, without shipping payloads off-box.

### Real-time vs batch
- **Held actions must be real-time** — an operator is waiting and the hold
  auto-denies at `PHINQ_HOLD_TIMEOUT_S`. Delivered over the persistent
  WebSocket; if the socket is down at hold time, see §3 fallback.
- **Audit sync is batch** — append-only, flushed every ~2s or N entries.
  Latency here is fine; integrity is not (§6).

### Audit sync keeping the chain intact
The chain is computed **locally** by the proxy (unchanged from OSS). The cloud
receives entries *already hashed* and stores them verbatim. The cloud runs the
same `verifyChain()` on ingest and **rejects a batch that doesn't extend the
last head it holds** for that instance. The cloud is a *replica + witness*, not
a re-hasher — it must never recompute hashes (that would let a compromised
cloud silently rewrite history and re-chain). See §6.

---

## 3. Approval gateway

```
proxy ──(1) hold created──▶ cloud ──(2) fan-out──▶ operator dashboards / push
  ▲                           │
  └──(4) decision + sig───────┘◀──(3) approver taps Approve/Deny
```

- **Transport:** a single **outbound WebSocket** from proxy to cloud
  (`wss://`), authenticated with the instance token, kept warm with pings.
  Held actions arrive as frames; decisions return on the same socket.
- **Delivery to operators:** cloud fans a new hold to all connected dashboards
  for the tenant + optional web-push/Slack/Telegram mirror.
- **Decision propagation:** approver taps → cloud validates role → sends the
  decision frame back down the proxy's socket → proxy resolves the hold
  exactly as a local CLI decision does today (`decided_by: "cloud:<user_id>"`).
- **Timeout handling:** the **proxy's** existing timeout remains authoritative.
  The cloud never holds the timer. If no decision arrives before
  `PHINQ_HOLD_TIMEOUT_S`, the proxy auto-denies locally and emits the
  `EXPIRED_TIMEOUT` transition — identical to today. The cloud is an
  *approval channel*, not the *enforcer*.
- **Cloud unreachable → fallback (critical):** the proxy treats the cloud as
  **one notifier among several** (it already has a `CompositeNotifier` for
  Telegram + Slack). If the WebSocket is down, holds still fire to
  Telegram/Slack/CLI and are still enforced. Losing the cloud degrades the
  *UI*, never the *governance*. This is the whole reason enforcement stays in
  the OSS proxy.

---

## 4. Dashboard

Views, in priority order:

1. **Live hold queue** (actionable) — pending holds across all the tenant's
   agents; tool, class, triggers, plain-English `why`, args_bytes, countdown
   to auto-deny; Approve/Deny for approvers. This is the product's core loop.
2. **Audit log viewer** (read-only) — the chain, filterable by agent / class /
   decision / time; a "verify chain" button that runs `verifyChain` client- or
   server-side and shows the head hash + any first-break. This is the
   Article-14 evidence surface.
3. **Agent overview** (read-only) — one row per proxy instance: last-seen,
   mode (shadow/enforce), hold rate, false-hold rate, token spend, connection
   health.
4. **Team management** (actionable, owner-only) — invite operators, assign
   approver/viewer, rotate/revoke instance tokens.
5. **Precedent review** (actionable, later) — surface `phinq learn` proposals
   for one-click apply pushed back down to the proxy's phinq.yaml.

Data the dashboard needs from the proxy: exactly the three tiers in §2. Nothing
more — the dashboard is a projection of what the proxy pushes.

---

## 5. Deployment / onboarding

### Connect an OSS proxy to the cloud
Registration is a browser-approved device-style flow so the instance token is
never pasted around:

```bash
phinq connect            # proxy prints a short code + opens phinq.co/connect
                         # operator approves in the dashboard (already OAuth'd)
                         # cloud issues the instance token → written to ~/.phinq/
```

Under the hood: `phinq connect` calls the cloud, gets a `device_code` +
`user_code`, the operator confirms in the dashboard (binding it to their
tenant), the proxy polls and receives `pht_<tenant>_<random>`, stores it
chmod-600 in `~/.phinq/phinq.env` as `PHINQ_CLOUD_TOKEN`, and opens the
WebSocket. No token ever transits a terminal the operator has to copy from.

### NAT / firewalls
Solved by design: the proxy only ever **dials out** (WebSocket + HTTPS). No
inbound ports, no tunnels, no static IP. A proxy on a laptop behind CGNAT works
identically to one on a public VPS.

### One-liner
```bash
npx @phinq/phinq   # existing wizard; gains a "connect to phinq.co? [y/N]" step
```

---

## 6. Security

### End-to-end for the approval flow
The **decision** frame (approve/deny) is the crown jewel — a forged approval
executes a destructive action. So the decision is **signed by the cloud with a
per-tenant key whose public half the proxy pins at registration**, and the
proxy verifies the signature before honoring it. TLS protects transport;
the signature protects against a compromised *cloud edge* replaying or forging
decisions. (v1 may ship TLS-only with signed decisions as the fast-follow;
noting it here so it isn't forgotten.)

### If the cloud is compromised, can it forge approvals?
- **Forge a decision:** only if it also holds the tenant's signing key. Keys in
  an HSM/KMS, per-tenant, never exported → edge compromise ≠ forgery.
- **Suppress/withhold a hold:** yes — but that fails *safe*. A hold never
  delivered simply auto-denies at the proxy. The cloud can annoy (deny things
  by silence), it cannot make the proxy *do* something.
- **This is the deliberate asymmetry:** the cloud can reduce availability,
  never violate safety. Safety lives in the OSS proxy.

### Can the cloud tamper with the audit history?
No — and this is provable, which is the point:
- The proxy computes hashes locally and **externally anchors** its chain head
  (the OSS spec §6 recommendation becomes automatic: the proxy periodically
  posts its latest `entry_hash` to the cloud *and* the operator can pin it
  elsewhere).
- The cloud stores entries verbatim and never re-hashes. On any read, the
  dashboard's "verify" re-runs `verifyChain` over the stored bytes; if the
  cloud altered an entry, the recomputed hash won't match the stored
  `entry_hash` and the chain breaks visibly.
- A cloud that rewrote the *whole* replica would produce a head that doesn't
  match the head the customer's own proxy holds (and anchored). **Divergence
  between the proxy's head and the cloud's head is itself the tamper alarm.**

The property to preserve, stated plainly: *a customer must be able to prove
their own oversight using only their local proxy's chain, treating the cloud as
an untrusted convenience.* Every choice above serves that.
