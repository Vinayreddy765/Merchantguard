# Architecture

## The problem

AI agents increasingly have the ability to execute payments. Razorpay's
own MCP server already gives any AI model 40+ tools to create orders,
generate payment links, capture payments, and issue refunds. That
solves *capability*. It does not solve *control*: what may an agent
buy, for whom, within what limits, and under what conditions?

MerchantGuard is the merchant-side control layer that sits between an
AI buyer and Razorpay's execution layer.

```
AI proposes. Policy decides. Razorpay executes. Audit proves.
```

## System diagram

```
EXTERNAL AI BUYER
      │
      │  natural-language purchase intent
      ▼
┌──────────────────────────────────────────┐
│              MERCHANTGUARD               │
│                                          │
│  1. Catalog Resolver                     │
│     policy-engine/catalog-resolver.js    │
│     → matches intent text to a product   │
│                                          │
│  2. Policy Evaluator (deterministic)     │
│     policy-engine/policy-evaluator.js    │
│     → ordinary if/else code, not an LLM  │
│     → AUTO_APPROVE / HUMAN_APPROVAL /    │
│       REJECT, with a structured checks[] │
│                                          │
│  3. Risk Gate (orchestrator)             │
│     policy-engine/risk-gate.js           │
│     → ties the above together            │
│     → re-validates state immediately     │
│       before any money action executes   │
│                                          │
│  4. Audit Logger                         │
│     policy-engine/audit-logger.js        │
│     → every decision, every check,       │
│       every MCP call, permanently logged │
└───────────────────┬──────────────────────┘
                     │
              ONLY APPROVED
                 ACTIONS
                     │
                     ▼
┌──────────────────────────────────────────┐
│           RAZORPAY MCP SERVER            │
│    mcp-integration/razorpay-mcp-client.js│
│                                          │
│  create_payment_link, create_order, etc. │
└──────────────────────────────────────────┘
                     │
                     ▼
            Real test-mode transaction
```

## Why the LLM never decides money questions

An LLM is used (implicitly, in how a buyer's natural-language intent
gets parsed) only to *interpret what was asked for*. It is never the
thing that decides whether a ₹7,000 transaction is allowed. That
decision is `policy-engine/policy-evaluator.js` - plain, deterministic
JavaScript comparing numbers and category strings against a merchant
policy row. This is a deliberate design choice: an LLM's judgment can
be prompted around, second-guessed, or produce different answers on
different runs. A merchant's spending policy should not have that
property. See `docs/policy-model.md` for the exact rules.

## Two-phase execution: evaluate, then re-validate

A purchase intent is handled in two separate function calls, not one:

1. **`handleIntent()`** - resolves the intent, evaluates policy against
   the catalog *as it exists right now*, logs the decision, and returns
   without touching Razorpay.
2. **`executeApprovedAction()`** - called separately, either immediately
   (for AUTO_APPROVE) or after a human clicks Approve (for
   HUMAN_APPROVAL). This function does **not** trust the decision
   computed in step 1. It re-fetches the product from the database and
   re-runs the full policy evaluation *again*, right before calling
   Razorpay MCP.

This exists because time passes between "a decision was made" and "the
decision is acted on" - a human approver might take minutes, or the
merchant might update a price in that window. See
`docs/failure-analysis.md` for a real, reproducible demonstration of
why this matters (`cli/demo-price-revalidation.js`).

## Data model

```
products        - the merchant's catalog (db/init-db.js)
policies        - one row per merchant, defines all thresholds/rules
agent_sessions  - one row per buyer intent, tracks status over time
audit_logs      - one row per decision point, with structured checks[]
```

Full schema in `db/init-db.js`.

## Request flow (HTTP layer)

```
POST /api/intent                → handleIntent() [+ execute if AUTO_APPROVE]
POST /api/sessions/:id/approve  → executeApprovedAction() [re-validates first]
POST /api/sessions/:id/reject   → marks session rejected, no MCP call
GET  /api/sessions              → list sessions (merchant dashboard)
GET  /api/sessions/:id/audit    → full structured audit trail
```

Implemented in `api/server.js`. The frontend (`frontend/src/`) is a
thin client over this API — it contains no policy logic of its own.
