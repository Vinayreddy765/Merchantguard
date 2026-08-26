# MerchantGuard — A Policy Gateway for Agentic Commerce

**What:** A policy gateway for AI commerce.
**Why:** Merchants need control over autonomous payment actions.
**How:** AI buyer → MerchantGuard → deterministic policy → Razorpay MCP.
**Does it work?** Yes — real Razorpay MCP, real test-mode execution.
**What's interesting?** Human-in-the-loop approval, agent velocity limits,
execution-time revalidation, and a fully structured audit trail.

> Razorpay's MCP server gives an AI agent the ability to pay.
> MerchantGuard gives the merchant the authority to decide what that agent is allowed to do with it.

AI agents increasingly have the ability to execute payments. Razorpay's
own MCP server already exposes 40+ payment tools directly to any
MCP-aware AI model. That solves *capability*. It does not solve
*control*: what may an agent buy, for whom, within what limits, and
under what conditions? MerchantGuard is the merchant-side control
layer that answers that question before anything reaches Razorpay.

> AI proposes. Policy decides. Razorpay executes. Audit proves.

## What actually happens, in one table

| Scenario | Policy result | Razorpay MCP |
|---|---|---|
| ₹1,299 Premium Coffee | Auto-approve | ✅ Executed |
| ₹3,597 3-Month Premium | Human approval | ✅ Executed after approval |
| ₹10,000 Gift Card | Reject (category not allowed) | ❌ 0 calls |
| 2nd subscription action, same buyer, same day | Reject (velocity) | ❌ 0 calls |
| Price changed after approval, before execution | Revalidate → block | ❌ 0 calls |
| MCP credentials missing/unreachable | Graceful failure, logged | ❌ No payment |

Every row above was run for real against Razorpay's live test-mode MCP
server — not simulated. Reproduction steps are in
[`docs/failure-analysis.md`](docs/failure-analysis.md) and
`cli/run-scenario.js` / `cli/demo-price-revalidation.js`.

**Full documentation:**
[`docs/architecture.md`](docs/architecture.md) ·
[`docs/policy-model.md`](docs/policy-model.md) ·
[`docs/mcp-integration.md`](docs/mcp-integration.md) ·
[`docs/failure-analysis.md`](docs/failure-analysis.md)

## Architecture

```
EXTERNAL AI BUYER
       |
  natural-language intent
       |
       v
+---------------------+
|   MERCHANTGUARD      |
|                      |
| Intent Resolution    |
| Policy Evaluation    |
| Risk Gate            |
| Audit                |
+----------+-----------+
           |
     ONLY APPROVED
        ACTIONS
           |
           v
+---------------------+
|   RAZORPAY MCP       |
|                      |
| create_order         |
| create_payment_link  |
| etc.                 |
+---------------------+
```

Full breakdown, including why policy decisions are deterministic code
rather than an LLM judgment call, in
[`docs/architecture.md`](docs/architecture.md).

## The policy: BrewCycle (fictional coffee subscription merchant)

```
AUTO_APPROVE     amount <= ₹2,000
HUMAN_APPROVAL   ₹2,001 – ₹5,000
REJECT           amount > ₹5,000

Allowed categories:  coffee_subscription, coffee_onetime
Restricted:           gift_card
Velocity:              max 1 subscription action / buyer / day
```

Every decision is logged as a structured `checks[]` array (rule,
expected, actual, pass/fail) — not a prose reason string. Full rule
rationale in [`docs/policy-model.md`](docs/policy-model.md).

## Verified capabilities

- ✓ Real Razorpay MCP execution — MerchantGuard currently discovers
  42 tools from Razorpay's live test-mode MCP server and has
  successfully called `create_payment_link` for real transactions
- ✓ Deterministic policy enforcement — 9/9 tests passing across every
  scenario boundary (`npm test`)
- ✓ Human-in-the-loop approval for mid-range transactions
- ✓ Agent velocity protection (max 1 subscription action/buyer/day)
- ✓ Execution-time price/inventory revalidation — proven with a real
  run, see engineering incidents below
- ✓ Structured, queryable audit trail for every decision
- ✓ Graceful MCP failure handling — failures are logged and surfaced,
  never silently swallowed or retried into a different outcome

## Engineering incidents

Three real problems were found and fixed while building this system —
kept here deliberately, not hidden, because they demonstrate three
different classes of engineering failure:

```
Natural-language ambiguity  ->  State interpretation  ->  Distributed-system state
```

**1. Plan duration vs. price parsing.** `"...for ₹1,299/month"` was
matching the wrong product — the word "month" in the price phrase
collided with "3 Month" in a different SKU's name.

**2. Duration vs. quantity.** `"Buy the 3-month Premium plan."` was
extracting quantity = 3 from the "3" in "3-month," conflating plan
duration with purchase quantity.

**3. External reference collision (the real incident).** While
repeatedly resetting the local database during testing, a live
Razorpay call failed with:
```
payment link with given reference_id: mg-session-2 already exists
```
The local session ID had restarted at 1 after a DB reset, but
Razorpay's remote reference state persisted independently. The initial
assumption — that the local database was the source of truth — was
wrong. The payment provider had state that hadn't been modeled.
Fixed by making `reference_id` globally unique regardless of local
resets.

Full write-up of all three, including exact commands and unedited
output, in [`docs/failure-analysis.md`](docs/failure-analysis.md).
Incident 3 is the primary "what broke" story: unexpected, caused by a
real external system, discovered during live integration, diagnosed,
and fixed. The execution-time revalidation demo
(`cli/demo-price-revalidation.js`) is kept as a second, deliberately
triggered demonstration that the same underlying safety property
holds architecturally, not just in this one incident.

## Setup

```bash
npm install
npm run init-db     # creates db/merchantguard.db, seeds BrewCycle catalog + policy
npm test             # runs the policy engine test suite (9 tests, all scenario boundaries)
cp .env.example .env
# edit .env with your Razorpay TEST MODE keys (Dashboard > Settings > API Keys)
npm run spike        # proves MCP connectivity
```

## Running the full stack

Terminal 1:
```bash
npm install
npm run init-db
cp .env.example .env    # your Razorpay TEST mode keys
npm run start             # backend on :4000
```

Terminal 2:
```bash
cd frontend
npm install
npm run dev                # frontend on :5173
```

Open http://localhost:5173 — click a sample intent button, watch the
decision render with its structured checks, approve pending items from
the Merchant Dashboard panel, and click through to see the full audit
trail update live.

## API reference

```
POST /api/intent                    { buyerId, rawIntent } -> resolves, evaluates, auto-executes if AUTO_APPROVE
POST /api/sessions/:id/approve      merchant approves a pending session -> revalidates -> executes
POST /api/sessions/:id/reject       merchant rejects a pending session
GET  /api/sessions?status=...       list sessions, optionally filtered
GET  /api/sessions/:id/audit        full structured audit trail for one session
```
