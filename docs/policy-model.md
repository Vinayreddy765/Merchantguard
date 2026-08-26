# Policy Model

This document describes the exact rules `policy-engine/policy-evaluator.js`
enforces for the demo merchant, BrewCycle. All values below are seeded
in `db/init-db.js` and can be inspected directly there.

## The merchant: BrewCycle (fictional coffee subscription brand)

| SKU | Category | Price | Billing |
|---|---|---|---|
| `starter-coffee-monthly` | coffee_subscription | ₹699 | monthly |
| `premium-coffee-monthly` | coffee_subscription | ₹1,299 | monthly |
| `premium-coffee-3month` | coffee_subscription | ₹3,597 | quarterly |
| `single-bag-coffee` | coffee_onetime | ₹499 | one-time |
| `gift-card-1000` | gift_card | ₹1,000 | one-time |

## The policy (one row per merchant)

```
max_auto_amount_paise    = 200000   (₹2,000)
max_human_amount_paise   = 500000   (₹5,000)
allowed_categories       = ["coffee_subscription", "coffee_onetime"]
max_quantity              = 5
velocity_limit_per_day   = 1  (subscription actions, per buyer)
```

## Decision thresholds

```
amount ≤ ₹2,000              → AUTO_APPROVE
₹2,000 < amount ≤ ₹5,000      → HUMAN_APPROVAL
amount > ₹5,000               → REJECT
category not in allowlist     → REJECT (regardless of amount)
product inactive              → REJECT
quantity outside 1–max        → REJECT
2nd subscription action today → REJECT (velocity)
```

Any single hard-fail (category, quantity, velocity, inactive product,
or amount above the human ceiling) forces REJECT, even if other checks
pass. See `evaluate()` in `policy-evaluator.js` for the exact logic.

## Every check is structured, not prose

A decision is never stored as a single string like `"rejected: too
expensive"`. Every evaluation produces an array of individual checks:

```json
{
  "rule": "max_human_amount",
  "expected": 500000,
  "actual": 600000,
  "result": "FAIL"
}
```

This is deliberate: a structured record lets the audit UI show exactly
which rule fired, with what numbers, rather than trusting a
human-readable (and possibly misleading) summary sentence. The
`reason` field that accompanies each decision is generated *from* this
array (`decisionReason()` in `risk-gate.js`), not the other way around.

## Why these specific rules

- **Category allowlist, not blocklist.** New product categories a
  merchant hasn't explicitly reviewed default to REJECT, not
  AUTO_APPROVE. Gift cards are excluded on purpose — an AI buyer
  autonomously purchasing a redeemable-value instrument is a
  meaningfully different risk than buying a physical product.
- **Velocity limit on subscriptions specifically**, not all purchases.
  A one-time purchase is a single decision point. A subscription
  action recurring unexpectedly (an agent looping, or a buyer's intent
  being re-triggered) is the failure mode worth guarding against, so
  the velocity check only applies to `coffee_subscription` category
  actions.
- **Three-tier thresholds instead of a single cutoff.** A binary
  allow/deny would either be too permissive (any amount auto-approved)
  or too restrictive (every purchase needs a human). The middle tier
  exists specifically to demonstrate the "gated" requirement from the
  buildathon brief — some actions should require a human in the loop,
  not just a policy check.

## Test coverage

`test/policy-evaluator.test.js` exercises every boundary in the table
above, including the exact ₹2,000 / ₹2,001 / ₹5,000 / ₹5,001 edges.
Run with `npm test` — currently 9/9 passing.
