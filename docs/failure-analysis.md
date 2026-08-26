# Failure Analysis

Two real issues were found while building and testing this system -
one found by accident during live testing , one deliberately triggered to 
prove a designed safety property. Both are documented here in full, 
with the actual commands and actual fixes.
Payment link URLs and IDs shown during development
are intentionally not reproduced verbatim in this document — they are
Razorpay test-mode artifacts, and while harmless, there's no reason to
publish them in a persistent, public document. Anyone can reproduce
identical results by running the scripts referenced below with their
own test-mode credentials.

---

## 1. External reference collision — the primary incident

### What happened

While repeatedly resetting the local database during testing, a live
call to Razorpay's MCP server failed:

```
payment link with given reference_id: mg-session-2 already exists.
Please create a payment link with a different reference_id
```

This was not staged. It surfaced unexpectedly while testing the
`/api/intent` endpoint from a browser and from PowerShell.

### Diagnosis

The first assumption was that the local database was the source of
truth for this system's state. It wasn't. `executeApprovedAction()`
built each payment link's `reference_id` from the local session ID
alone:

```js
referenceId: `mg-session-${sessionId}`,
```

Local session IDs are SQLite `AUTOINCREMENT` values that reset to 1
every time the database is re-initialized (`npm run init-db`). But
Razorpay's MCP server remembers every `reference_id` it has ever seen,
permanently, independent of what the local database does. After a
local reset, the next session numbered `2` collided with a
`reference_id` from a completely unrelated earlier test run — because
from Razorpay's point of view, that reference was never freed. The
payment provider had state that hadn't been modeled.

```
Local DB reset
      |
session IDs restart at 1
      |
mg-session-2 generated again
      |
Razorpay remembers old reference_id
      |
MCP call rejected: "reference_id already exists"
      |
Investigate
      |
Discover external state persists independently of local state
      |
Generate a globally unique reference_id
      |
Retry -> SUCCESS
```

### The fix

```js
referenceId: `mg-session-${sessionId}-${randomUUID().slice(0, 8)}`,
```

Appending a random suffix makes every attempt globally unique on
Razorpay's side, regardless of how many times the local database has
been reset. See `policy-engine/risk-gate.js`.

### The lesson

**Our local state was fresh. Razorpay's state wasn't.** This is
exactly the kind of state-modeling gap that shows up in real
distributed systems: a component's own storage can be reset,
versioned, or rebuilt, but any external system it talks to may retain
history the local component has no visibility into. The fix here is
narrow (a UUID suffix), but the underlying principle — never assume an
external system's state matches your local, resettable one — is the
same principle behind the execution-time revalidation property
described below.

---

## 2. Execution-time price revalidation — deliberately triggered

### The property being tested

`executeApprovedAction()` in `policy-engine/risk-gate.js` is designed
to re-fetch a product's current state and re-run policy evaluation
immediately before calling Razorpay — rather than trusting the
decision computed when the buyer's intent was first evaluated. This
matters because a real gap exists between "a decision was made" and
"the decision is acted on": a human approver might take minutes to
click Approve, and in that window, a merchant could change a price.

Unlike incident 1, this was not found by accident — it was
deliberately staged to confirm a safety property the architecture was
designed to have from the start.

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
-> Session #1 is now PENDING_APPROVAL, waiting for the merchant.

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

The system did not charge the stale ₹3,597 price, and did not
silently charge the new ₹6,000 price either. It stopped the
transaction entirely and left an honest audit trail explaining why —
proving, with a real run rather than an assertion, that the
architecture's "explainable, bounded, gated" property actually holds.

Reproduce it yourself: `node cli/demo-price-revalidation.js` — no
Razorpay credentials required, since execution never reaches Razorpay
in this scenario.

---

## Two other resolver-level fixes, for completeness

Two smaller natural-language interpretation bugs were found and fixed
while testing the catalog resolver against demo phrases:

- `"...for ₹1,299/month"` was matching the wrong product, because the
  word "month" appeared both in the price phrase and in a different
  SKU's name ("3 Month"). Fixed by excluding generic/stopword terms
  from scoring.
- `"Buy the 3-month Premium plan."` was extracting quantity = 3 from
  the "3" in "3-month," conflating plan duration with purchase
  quantity. Fixed by requiring an explicit quantity unit before
  treating a number as a quantity.

These are lower-stakes than the two incidents above (natural-language
parsing, not payment-execution state), but are kept in the record
since they demonstrate a third class of problem: ambiguity in
converting free text into a structured decision, distinct from either
state-modeling failure above.

---

## What these findings say about the system, together

None of these were catastrophic. All were caught, handled gracefully
(a clear error, a blocked transaction, an honest audit entry), and
fixed. That is the actual point of the "bounded and gated"
requirement: not that failures never happen, but that when they do,
the system fails in a way that is visible, explainable, and never
silently does the wrong thing with real money.
