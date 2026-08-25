/**
 * run-scenario.js
 *
 * Runs the three demo scenarios end-to-end through the real flow:
 * intent -> resolve -> policy evaluate -> (approve if needed) -> MCP execute.
 *
 * This calls the REAL Razorpay MCP server in test mode for any scenario
 * that reaches AUTO_APPROVE or gets approved — so running this will
 * actually create test-mode payment links in your Razorpay dashboard.
 *
 * Usage:
 *   node cli/run-scenario.js auto      -> Scenario 1: auto-approved purchase
 *   node cli/run-scenario.js human     -> Scenario 2: human-approval required, then approved
 *   node cli/run-scenario.js reject    -> Scenario 3: rejected (gift card, over limit)
 *   node cli/run-scenario.js all       -> runs all three in sequence
 */

import { handleIntent, executeApprovedAction } from "../policy-engine/risk-gate.js";

function printChecks(checks) {
  for (const c of checks) {
    const mark = c.result === "PASS" ? "✓" : "✗";
    console.log(`   ${mark} ${c.rule}  expected=${JSON.stringify(c.expected)}  actual=${JSON.stringify(c.actual)}`);
  }
}

async function runAutoApprove() {
  console.log("\n=== SCENARIO 1: Auto-Approved ===");
  console.log('Intent: "Subscribe me to Premium Coffee for ₹1,299/month."\n');

  const result = handleIntent({
    buyerId: "buyer_scenario_1",
    rawIntent: "Subscribe me to Premium Coffee for ₹1,299/month.",
  });

  console.log(`Product matched: ${result.product?.name ?? "none"}`);
  console.log(`Amount: ₹${(result.totalAmountPaise / 100).toFixed(2)}`);
  console.log(`Decision: ${result.decision}\n`);
  printChecks(result.checks);

  if (result.decision === "AUTO_APPROVE") {
    console.log("\n→ Executing via Razorpay MCP...");
    const exec = await executeApprovedAction(result.sessionId);
    console.log(`Execution: ${exec.decision}`);
    if (exec.mcpResult?.success) {
      const text = exec.mcpResult.result?.content?.[0]?.text;
      const parsed = text ? JSON.parse(text) : null;
      console.log(`✅ Payment link created: ${parsed?.short_url ?? "(see full result)"}`);
    } else {
      console.log(`❌ Execution failed: ${exec.mcpResult?.error}`);
    }
  }
}

async function runHumanApproval() {
  console.log("\n=== SCENARIO 2: Human Approval Required ===");
  console.log('Intent: "Buy the 3-month Premium plan."\n');

  const result = handleIntent({
    buyerId: "buyer_scenario_2",
    rawIntent: "Buy the 3-month Premium plan.",
  });

  console.log(`Product matched: ${result.product?.name ?? "none"}`);
  console.log(`Amount: ₹${(result.totalAmountPaise / 100).toFixed(2)}`);
  console.log(`Decision: ${result.decision}\n`);
  printChecks(result.checks);

  if (result.decision === "HUMAN_APPROVAL") {
    console.log("\n→ [Simulating merchant dashboard] PENDING ACTION");
    console.log(`   Buyer: buyer_scenario_2`);
    console.log(`   Product: ${result.product.name}`);
    console.log(`   Amount: ₹${(result.totalAmountPaise / 100).toFixed(2)}`);
    console.log(`   Reason: ${result.reason}`);
    console.log("\n→ [Merchant clicks APPROVE]");
    console.log("→ Executing via Razorpay MCP...");

    const exec = await executeApprovedAction(result.sessionId);
    console.log(`Execution: ${exec.decision}`);
    if (exec.mcpResult?.success) {
      const text = exec.mcpResult.result?.content?.[0]?.text;
      const parsed = text ? JSON.parse(text) : null;
      console.log(`✅ Payment link created: ${parsed?.short_url ?? "(see full result)"}`);
    } else {
      console.log(`❌ Execution failed: ${exec.mcpResult?.error}`);
    }
  }
}

async function runReject() {
  console.log("\n=== SCENARIO 3: Rejected ===");
  console.log('Intent: "Buy a ₹10,000 gift card."\n');

  const result = handleIntent({
    buyerId: "buyer_scenario_3",
    rawIntent: "Buy a ₹10,000 gift card.",
  });

  console.log(`Product matched: ${result.product?.name ?? "none"}`);
  console.log(`Decision: ${result.decision}\n`);
  if (result.checks) printChecks(result.checks);
  console.log(`\nRazorpay MCP calls: 0`);
  console.log(`Message to buyer: "I can't complete this transaction — ${result.reason}"`);
}

const scenario = process.argv[2];

(async () => {
  if (scenario === "auto") await runAutoApprove();
  else if (scenario === "human") await runHumanApproval();
  else if (scenario === "reject") await runReject();
  else if (scenario === "all") {
    await runAutoApprove();
    await runHumanApproval();
    await runReject();
  } else {
    console.log("Usage: node cli/run-scenario.js [auto|human|reject|all]");
    process.exit(1);
  }
})();
