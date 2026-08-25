/**
 * demo-price-revalidation.js
 *
 * DELIBERATELY triggers the exact scenario the risk gate was designed to
 * catch: a merchant changes a product's price AFTER a buyer's purchase
 * was evaluated, but BEFORE it executes. This proves that authorization
 * is checked against the state being transacted, not the state that was
 * true when the decision was first made.
 *
 * This does NOT need Razorpay credentials to run — the whole point is
 * that revalidation catches the problem and blocks execution BEFORE any
 * MCP call is made. Zero Razorpay calls happen in this script.
 *
 * Usage: node cli/demo-price-revalidation.js
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleIntent, executeApprovedAction } from "../policy-engine/risk-gate.js";
import { getAuditTrail } from "../policy-engine/audit-logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "db", "merchantguard.db");

function printChecks(checks) {
  for (const c of checks) {
    const mark = c.result === "PASS" ? "✓" : "✗";
    console.log(`   ${mark} ${c.rule}  expected=${JSON.stringify(c.expected)}  actual=${JSON.stringify(c.actual)}`);
  }
}

async function main() {
  console.log("=== PRICE REVALIDATION DEMO ===\n");

  // --- Step 1: buyer's intent gets evaluated at the ORIGINAL price ---
  console.log('Step 1: Buyer sends intent: "Buy the 3-month Premium plan."');
  console.log("         (original price: ₹3,597 → within HUMAN_APPROVAL range)\n");

  const result = handleIntent({
    buyerId: "revalidation_demo_buyer",
    rawIntent: "Buy the 3-month Premium plan.",
  });

  console.log(`Decision at evaluation time: ${result.decision}`);
  printChecks(result.checks);
  console.log(`\n→ Session #${result.sessionId} is now PENDING_APPROVAL, waiting for the merchant.\n`);

  if (result.decision !== "HUMAN_APPROVAL") {
    console.error("Expected HUMAN_APPROVAL at this step — aborting demo. Did the catalog seed change?");
    process.exit(1);
  }

  // --- Step 2: BEFORE the merchant approves, the merchant changes the price ---
  // This simulates a real-world race: a catalog update lands in the gap
  // between when a buyer's request was first evaluated and when a human
  // gets around to clicking Approve.
  console.log("Step 2: [SIMULATING] Merchant updates the 3-Month Premium plan's price");
  console.log("         while this session is still sitting in the approval queue.");
  console.log("         New price: ₹6,000 (was ₹3,597) — now ABOVE the ₹5,000 reject ceiling.\n");

  const db = new Database(DB_PATH);
  db.prepare("UPDATE products SET price_paise = ? WHERE sku = ?").run(600000, "premium-coffee-3month");
  db.close();

  // --- Step 3: merchant clicks Approve, unaware the price just changed ---
  console.log("Step 3: Merchant clicks APPROVE on the original ₹3,597 request they saw.\n");
  console.log("→ executeApprovedAction() re-fetches the product fresh and re-runs policy");
  console.log("  evaluation BEFORE calling Razorpay — it does not trust the earlier decision.\n");

  const exec = await executeApprovedAction(result.sessionId);

  console.log(`Revalidation decision: ${exec.decision}`);
  if (exec.checks) printChecks(exec.checks);
  console.log(`\nReason: ${exec.reason}`);

  if (exec.decision === "REJECT") {
    console.log("\n✅ CORRECT BEHAVIOR: execution was BLOCKED because the price changed.");
    console.log("   The buyer was never charged the stale ₹3,597 price, and was not");
    console.log("   silently charged the new ₹6,000 price either — the transaction");
    console.log("   was stopped entirely and the merchant/buyer would need to restart.");
  } else {
    console.log("\n❌ UNEXPECTED: revalidation should have rejected this. Investigate.");
  }

  // --- Step 4: show the full audit trail proves this happened, with reasons ---
  console.log("\n=== Full audit trail for this session ===\n");
  const db2 = new Database(DB_PATH, { readonly: true });
  const trail = getAuditTrail(db2, result.sessionId);
  db2.close();

  for (const entry of trail) {
    console.log(`[${entry.action}] actor=${entry.actor} decision=${entry.decision}`);
    console.log(`   reason: ${entry.reason}`);
  }

  console.log(
    "\nNote: no EXECUTE_PURCHASE / MCP call appears above — execution was stopped\n" +
      "at the REVALIDATE step, before Razorpay was ever contacted. Zero MCP calls made.\n"
  );
}

main();
