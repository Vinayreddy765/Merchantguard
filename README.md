# MerchantGuard - A Policy Gateway for Agentic Commerce

MerchantGuard sits between AI buyers and Razorpay's MCP execution layer,
allowing merchants to expose commerce to AI agents while enforcing
spending, product, subscription, velocity, and human-approval policies.

> Razorpay MCP gives an AI agent the ability to pay.
> MerchantGuard gives the merchant the authority to decide what that agent is allowed to do.

## Day 1: Prove MCP connectivity (do this first)

```bash
npm install
cp .env.example .env
# edit .env with your Razorpay TEST MODE keys (Dashboard > Settings > API Keys)
npm run spike
```

If `npm run spike` prints `SPIKE PASSED`, our backend can call Razorpay's
MCP server directly — safe to proceed with the policy engine.

If it fails, read the error output — it tells you the fallback plan
(direct REST API + documented MCP-compatibility target).

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

## Setup

```bash
npm install
npm run init-db     # creates db/merchantguard.db, seeds BrewCycle catalog + policy
npm test            # runs the policy engine test suite (9 tests, all scenario boundaries)
cp .env.example .env
# edit .env with your Razorpay TEST MODE keys
npm run spike        # proves MCP connectivity — already confirmed working
```

## The policy: BrewCycle (fictional coffee subscription merchant)

```
AUTO_APPROVE     amount <= ₹2,000
HUMAN_APPROVAL   ₹2,001 – ₹5,000
REJECT           amount > ₹5,000

Allowed categories:  coffee_subscription, coffee_onetime
Restricted:           gift_card
Velocity:              max 1 subscription action / buyer / day
```

Every decision is logged as a structured `checks[]` array (rule, expected,
actual, pass/fail) — not a prose reason string. See `policy-engine/policy-evaluator.js`.

## Status
- [x] Repo scaffold
- [x] MCP connectivity spike — CONFIRMED WORKING against real Razorpay MCP server
      (42 tools discovered, `create_payment_link` called successfully, real
      payment link returned: `plink_TSnD9Qkh06sDgJ`)
- [x] Catalog + database (5 BrewCycle products, 1 merchant policy, SQLite)
- [x] Policy engine core — deterministic, 9/9 tests passing across all
      scenario boundaries (auto-approve, human-approval, reject, gift card,
      inactive product, quantity limit)
- [x] Catalog resolver (intent -> product matching)
- [x] Risk gate + session/audit wiring — CONFIRMED WORKING. All three CLI
      scenarios ran end-to-end for real:
        - Scenario 1 (auto-approve, Premium Coffee ₹1,299) → executed,
          real payment link created (`rzp.io/rzp/ZTUVh6p`)
        - Scenario 2 (human-approval, 3-Month Premium ₹3,597) → routed
          for approval, approved, executed, real payment link created
          (`rzp.io/rzp/z2CQFvk1`)
        - Scenario 3 (reject, gift card) → rejected on category rule,
          zero Razorpay calls made
- [x] Razorpay MCP execution path — real test-mode payments confirmed
- [x] Price/inventory revalidation at execution time (see risk-gate.js)
- [x] API server (Express) — `POST /api/intent`, `POST /api/sessions/:id/approve`,
      `POST /api/sessions/:id/reject`, `GET /api/sessions`,
      `GET /api/sessions/:id/audit` — all tested and working over real HTTP
- [x] Dashboard + audit trail UI — React frontend built and verified. Three
      panels: Chat (buyer intent), Merchant Dashboard (pending approvals),
      Audit Trail (structured checks, receipt-ledger style). Full data flow
      tested end-to-end via the real API (intent → pending → approve →
      audit trail all confirmed working, including a real graceful-failure
      render when MCP credentials are absent).
- [x] Human approval UI — Approve/Reject buttons wired to the real endpoints
- [ ] Failure injection scenarios + the price-revalidation bug (demo-ready)
- [ ] Video + final README polish

## Two candidate "what broke" stories — pick one for the video

Both are real, both are documented, both are reproducible. You don't need
both in the video — pick whichever tells a better 60-90 second story.

**Story A — the reference_id collision (found by accident, live testing)**
See finding #3 above. Real bug, hit unexpectedly while testing the API
from PowerShell, root-caused and fixed in minutes. Strongest as a "here's
what actually goes wrong when you build fast" story — it's unscripted.

**Story B — the price revalidation (triggered deliberately, proves a design principle)**
Run `node cli/demo-price-revalidation.js` to see it. This is NOT an
accidental bug — it's a deliberate stress test of a property the system
was designed to have from day one: a merchant changes a product's price
while a buyer's request sits in the approval queue, and the system
catches the mismatch and blocks execution instead of charging either the
stale or the new price silently. Zero Razorpay calls are made. Strongest
as a "here's the exact failure mode this architecture exists to prevent,
and I proved it actually works" story — more aligned with the track's
"every money action explainable, bounded and gated" bar.

My recommendation: **lead with Story B** in the video since it directly
demonstrates the track's core requirement, then mention Story A briefly
as a second, real-world example of the same underlying lesson (external
systems remember state you assumed was fresh).

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

## Running the API server

```bash
npm install
npm run init-db
cp .env.example .env      # fill in Razorpay TEST mode keys
npm run start              # starts on http://localhost:4000
```

Endpoints:
- `POST /api/intent` — `{ buyerId, rawIntent }` → resolves, evaluates policy,
  auto-executes if AUTO_APPROVE
- `POST /api/sessions/:id/approve` — merchant approves a pending session, triggers
  revalidation + execution
- `POST /api/sessions/:id/reject` — merchant rejects a pending session
- `GET /api/sessions?status=pending_approval` — list sessions, optionally filtered
- `GET /api/sessions/:id/audit` — full structured audit trail for one session

## Known findings so far (candidates for the "what broke" story)

While testing the catalog resolver against real demo phrases, found two
real bugs before they could show up in the demo:

1. `"...for ₹1,299/month"` was matching the wrong product (3-month plan
   instead of monthly plan) because the word "month" appeared in both
   the price phrase and the 3-month SKU's name. Fixed by excluding
   generic/stopword terms from scoring and adding explicit phrase-level
   disambiguation for plan duration.
2. `"Buy the 3-month Premium plan."` was extracting quantity=3 from the
   "3" in "3-month" — conflating plan duration with purchase quantity.
   Fixed by requiring an explicit quantity unit (x, units, bags, packs,
   qty) before treating a number as a quantity.
3. **[Real, found via live testing, strong 2am-story candidate]**
   `reference_id` collisions against Razorpay's remote state. Razorpay's
   MCP server dedupes payment links by `reference_id`, and that record
   persists on Razorpay's side *forever* — but local session IDs reset
   to 1 every time the local DB is re-initialized (`npm run init-db`).
   Re-running the demo after a DB reset caused `mg-session-2` to collide
   with a reference already created on a prior run, and the real
   Razorpay API rejected the call with `"payment link with given
   reference_id: mg-session-2 already exists"`. Fixed by appending a
   random suffix to `reference_id` (see `risk-gate.js`) so it stays
   globally unique regardless of local DB state. The underlying lesson
   is the same one behind the price-revalidation principle: **local
   state can be "fresh" while an external system remembers more than
   you assumed** — worth treating this as the primary 2am story instead
   of (or alongside) the price-revalidation scenario, since it's real,
   not staged.

These are logged here as real engineering history, not manufactured for
the pitch — worth revisiting when writing the final "2am" story to see
if the price-revalidation scenario (from the original design doc) is
still the most interesting one to tell, or if one of these resolver bugs
turns out to be more illustrative once the full flow is wired up.
