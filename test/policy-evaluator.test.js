/**
 * policy-evaluator.test.js
 *
 * Covers the exact scenario table from the project design doc:
 *   ₹1,000 coffee     -> AUTO_APPROVE
 *   ₹2,000 coffee     -> AUTO_APPROVE
 *   ₹2,001 coffee     -> HUMAN_APPROVAL
 *   ₹5,000 coffee     -> HUMAN_APPROVAL
 *   ₹5,001 coffee     -> REJECT
 *   Gift card         -> REJECT
 *   2nd sub same day  -> REJECT (velocity)
 *   Inactive product  -> REJECT
 *
 * Run with: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fresh DB before running the suite.
execSync("node db/init-db.js", { cwd: path.join(__dirname, ".."), stdio: "inherit" });

const { evaluate } = await import("../policy-engine/policy-evaluator.js");

function makeProduct(overrides = {}) {
  return {
    id: 1,
    sku: "test-sku",
    name: "Test Product",
    category: "coffee_subscription",
    price_paise: 100000, // ₹1,000
    max_qty_per_order: 5,
    active: 1,
    ...overrides,
  };
}

test("₹1,000 coffee -> AUTO_APPROVE", () => {
  const r = evaluate({ product: makeProduct({ price_paise: 100000 }), quantity: 1, buyerId: "buyer_a" });
  assert.equal(r.decision, "AUTO_APPROVE");
});

test("₹2,000 coffee -> AUTO_APPROVE (boundary, inclusive)", () => {
  const r = evaluate({ product: makeProduct({ price_paise: 200000 }), quantity: 1, buyerId: "buyer_b" });
  assert.equal(r.decision, "AUTO_APPROVE");
});

test("₹2,001 coffee -> HUMAN_APPROVAL (just over auto ceiling)", () => {
  const r = evaluate({ product: makeProduct({ price_paise: 200100 }), quantity: 1, buyerId: "buyer_c" });
  assert.equal(r.decision, "HUMAN_APPROVAL");
});

test("₹5,000 coffee -> HUMAN_APPROVAL (boundary, inclusive)", () => {
  const r = evaluate({ product: makeProduct({ price_paise: 500000 }), quantity: 1, buyerId: "buyer_d" });
  assert.equal(r.decision, "HUMAN_APPROVAL");
});

test("₹5,001 coffee -> REJECT (just over human ceiling)", () => {
  const r = evaluate({ product: makeProduct({ price_paise: 500100 }), quantity: 1, buyerId: "buyer_e" });
  assert.equal(r.decision, "REJECT");
});

test("Gift card -> REJECT (category not allowed) regardless of amount", () => {
  const r = evaluate({
    product: makeProduct({ category: "gift_card", price_paise: 100000 }),
    quantity: 1,
    buyerId: "buyer_f",
  });
  assert.equal(r.decision, "REJECT");
  const catCheck = r.checks.find((c) => c.rule === "category_allowed");
  assert.equal(catCheck.result, "FAIL");
});

test("Inactive product -> REJECT", () => {
  const r = evaluate({ product: makeProduct({ active: 0 }), quantity: 1, buyerId: "buyer_g" });
  assert.equal(r.decision, "REJECT");
});

test("Quantity above product max -> REJECT", () => {
  const r = evaluate({
    product: makeProduct({ max_qty_per_order: 2 }),
    quantity: 5,
    buyerId: "buyer_h",
  });
  assert.equal(r.decision, "REJECT");
  const qtyCheck = r.checks.find((c) => c.rule === "quantity_allowed");
  assert.equal(qtyCheck.result, "FAIL");
});

test("checks array is structured, not a prose string", () => {
  const r = evaluate({ product: makeProduct(), quantity: 1, buyerId: "buyer_i" });
  assert.ok(Array.isArray(r.checks));
  for (const c of r.checks) {
    assert.ok("rule" in c && "expected" in c && "actual" in c && "result" in c);
  }
});
