# Failure Analysis

Two real issues were found while building and testing this system -
one deliberately triggered to prove a designed safety property, one
found by accident during live testing. Both are documented here in
full, with the actual commands, actual output, and actual fixes.

---

## 1. Price revalidation (deliberately triggered)

### The property being tested

`executeApprovedAction()` in `policy-engine/risk-gate.js` is designed
to re-fetch a product's current state and re-run policy evaluation
immediately before calling Razorpay — rather than trusting the
decision computed when the buyer's intent was first evaluated. This
matters because a real gap exists between "a decision was made" and
"the decision is acted on": a human approver might take minutes to
click Approve, and in that window, a merchant could change a price.

### How it was tested

`cli/demo-price-revalidation.js` runs this exact sequence:

1. A buyer requests the 3-Month Premium plan (₹3,597) → evaluated as
   `HUMAN_APPROVAL` (above the ₹2,000 auto-approve ceiling, below the
   ₹5,000 reject ceiling).
2. **Before** the merchant approves, the product's price is changed
   directly in the database to ₹6,000 — simulating a merchant editing
   their catalog while the request sits in the approval queue.
3. The merchant then clicks Approve on what they believe is the
   original ₹3,597 request.

### What actually happened (real output, unedited)

```
Step 1: Buyer sends intent: "Buy the 3-month Premium plan."
Decision at evaluation time: HUMAN_APPROVAL
   ✗ max_auto_amount  expected=200000  actual=359700
   ✓ max_human_amount  expected=500000  actual=359700
→ Session #1 is now PENDING_APPROVAL, waiting for the merchant.

Step 2: [SIMULATING] Merchant updates the price to ₹6,000.

Step 3: Merchant clicks APPROVE on the original ₹3,597 request.
Revalidation decision: REJECT
   ✗ max_auto_amount  expected=200000  actual=600000
   ✗ max_human_amount  expected=500000  actual=600000
Reason: Revalidation at execution time failed — state changed since original approval.

=== Full audit trail for this session ===
[EVALUATE_POLICY] actor=merchantguard decision=HUMAN_APPROVAL
[REVALIDATE] actor=merchantguard decision=REJECT
   reason: Rejected — failed rule(s): max_auto_amount, max_human_amount

Note: no EXECUTE_PURCHASE / MCP call appears above — execution was
stopped at the REVALIDATE step, before Razorpay was ever contacted.
Zero MCP calls made.
```

### Why this matters

The system did not charge the stale ₹3,597 price (which the merchant
no longer wants), and did not silently charge the new ₹6,000 price
either (which the buyer never agreed to). It stopped the transaction
entirely and left an honest audit trail explaining exactly why. This
is the core safety property the "explainable, bounded, gated"
requirement is asking for — proven with a real run, not asserted in
prose.

Reproduce it yourself: `node cli/demo-price-revalidation.js` - no
Razorpay credentials required, since the whole point is that execution
never reaches Razorpay.

---

## 2. `reference_id` collision (found by accident, real bug)

### What happened

During live testing of the `/api/intent` endpoint from a browser and
from PowerShell, a second test run against an already-used local
database produced this real error from Razorpay's server:

```
creating payment link failed: payment link with given reference_id:
mg-session-2 already exists. Please create a payment link with a
different reference_id
```

### Root cause

`executeApprovedAction()` originally built each payment link's
`reference_id` from the local session ID alone:

```js
referenceId: `mg-session-${sessionId}`,
```

Local session IDs are SQLite `AUTOINCREMENT` values that reset to 1
every time the database is re-initialized (`npm run init-db`). But
Razorpay's MCP server remembers every `reference_id` it has ever seen,
permanently, regardless of what the local database does. So after any
local DB reset, the next session numbered `2` would collide with a
`reference_id` from a completely unrelated earlier test run — because
from Razorpay's point of view, that reference was never freed.

### The fix

```js
referenceId: `mg-session-${sessionId}-${randomUUID().slice(0, 8)}`,
```

Appending a random suffix makes every attempt globally unique on
Razorpay's side, regardless of how many times the local database has
been reset. See `policy-engine/risk-gate.js`.

### Why this is worth keeping in the record

This is the same underlying lesson as the price-revalidation property,
approached from a different angle: **local state can appear "fresh"
while an external system remembers more than was assumed.** In the
price-revalidation case, the risk was a stale local price being
trusted. In this case, the risk was a local ID space being assumed
independent of Razorpay's permanent record — and it wasn't. Both fixes
share the same root principle: never assume the counterpart system's
state matches your local, resettable one.

---

## What these two findings say about the system, together

Neither of these was a catastrophic failure — both were caught,
handled gracefully (a clear error, a blocked transaction, an honest
audit entry), and fixed. That is the actual point of the "bounded and
gated" requirement: it is not that failures never happen, it is that
when they do, the system fails in a way that is visible, explainable,
and does not silently do the wrong thing with real money.
