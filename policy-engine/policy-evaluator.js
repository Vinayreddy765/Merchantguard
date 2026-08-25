/**
 * policy-evaluator.js
 *
 * THE CORE OF MERCHANTGUARD.
 *
 * This is deterministic, ordinary code — not an LLM call. An LLM is fine
 * for interpreting buyer intent or explaining a decision in friendly
 * language, but it must never be the thing that decides whether a
 * ₹7,000 transaction is allowed. That decision lives here, as plain
 * if/else logic against merchant-defined policy rows.
 *
 * Every evaluation returns a structured `checks` array — each rule,
 * its expected/actual values, and pass/fail — not just a summary
 * string. This is what makes the audit trail convincing instead of
 * decorative.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "db", "merchantguard.db");

function getDb() {
  return new Database(DB_PATH);
}

/**
 * evaluate({ product, quantity, buyerId, merchantId }) -> {
 *   decision: "AUTO_APPROVE" | "HUMAN_APPROVAL" | "REJECT",
 *   checks: [ { rule, expected, actual, result } ],
 *   totalAmountPaise
 * }
 */
export function evaluate({ product, quantity, buyerId, merchantId = "brewcycle" }) {
  const db = getDb();
  try {
    const policy = db
      .prepare("SELECT * FROM policies WHERE merchant_id = ?")
      .get(merchantId);

    if (!policy) {
      return {
        decision: "REJECT",
        checks: [{ rule: "policy_exists", expected: true, actual: false, result: "FAIL" }],
        totalAmountPaise: 0,
      };
    }

    const checks = [];
    const allowedCategories = JSON.parse(policy.allowed_categories);

    // --- Check 1: product must be active ---
    checks.push({
      rule: "product_active",
      expected: true,
      actual: !!product.active,
      result: product.active ? "PASS" : "FAIL",
    });

    // --- Check 2: category allowed ---
    const categoryOk = allowedCategories.includes(product.category);
    checks.push({
      rule: "category_allowed",
      expected: allowedCategories,
      actual: product.category,
      result: categoryOk ? "PASS" : "FAIL",
    });

    // --- Check 3: quantity within product max AND policy max ---
    const qtyLimit = Math.min(product.max_qty_per_order, policy.max_quantity);
    const qtyOk = quantity > 0 && quantity <= qtyLimit;
    checks.push({
      rule: "quantity_allowed",
      expected: `1-${qtyLimit}`,
      actual: quantity,
      result: qtyOk ? "PASS" : "FAIL",
    });

    // --- Check 4: velocity — max N subscription actions per buyer per day ---
    let velocityOk = true;
    if (product.category === "coffee_subscription") {
      const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
      const row = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM agent_sessions s
           JOIN audit_logs a ON a.session_id = s.id
           WHERE s.buyer_id = ? AND a.decision IN ('AUTO_APPROVE','HUMAN_APPROVAL')
           AND a.action = 'EXECUTE_PURCHASE' AND a.timestamp >= ?`
        )
        .get(buyerId, since);
      velocityOk = row.cnt < policy.velocity_limit_per_day;
      checks.push({
        rule: "velocity_limit",
        expected: `< ${policy.velocity_limit_per_day} subscription action(s) / day`,
        actual: row.cnt,
        result: velocityOk ? "PASS" : "FAIL",
      });
    }

    // --- Amount thresholds ---
    const totalAmountPaise = product.price_paise * quantity;
    const autoOk = totalAmountPaise <= policy.max_auto_amount_paise;
    const humanOk = totalAmountPaise <= policy.max_human_amount_paise;

    checks.push({
      rule: "max_auto_amount",
      expected: policy.max_auto_amount_paise,
      actual: totalAmountPaise,
      result: autoOk ? "PASS" : "FAIL",
    });
    checks.push({
      rule: "max_human_amount",
      expected: policy.max_human_amount_paise,
      actual: totalAmountPaise,
      result: humanOk ? "PASS" : "FAIL",
    });

    // --- Final decision ---
    // Any hard-fail (category, quantity, velocity, inactive product, or
    // amount above human ceiling) => REJECT, regardless of amount.
    const hardFail =
      !product.active || !categoryOk || !qtyOk || !velocityOk || !humanOk;

    let decision;
    if (hardFail) {
      decision = "REJECT";
    } else if (autoOk) {
      decision = "AUTO_APPROVE";
    } else {
      decision = "HUMAN_APPROVAL";
    }

    return { decision, checks, totalAmountPaise };
  } finally {
    db.close();
  }
}
