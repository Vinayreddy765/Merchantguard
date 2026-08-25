/**
 * risk-gate.js
 *
 * The orchestrator. This is what ties the catalog resolver, the policy
 * evaluator, the audit logger, and the Razorpay MCP client into one
 * real flow.
 *
 * IMPORTANT DESIGN RULE: policy is evaluated against a FRESH product
 * lookup at execution time, not just at intent-resolution time. If a
 * merchant changes a price between when the buyer's intent was first
 * evaluated and when the payment actually executes, re-checking against
 * stale data would authorize a transaction against a price that no
 * longer exists. So `executeApprovedAction` re-fetches the product and
 * re-runs the policy evaluator immediately before calling Razorpay MCP,
 * rather than trusting the decision computed earlier. See REVALIDATION
 * NOTE below for exactly where this matters.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resolveIntent, extractQuantity } from "./catalog-resolver.js";
import { evaluate } from "./policy-evaluator.js";
import { createSession, updateSessionStatus, logAudit, getDb } from "./audit-logger.js";
import { createPaymentLink } from "../mcp-integration/razorpay-mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "db", "merchantguard.db");

function getFreshProduct(db, sku) {
  return db.prepare("SELECT * FROM products WHERE sku = ?").get(sku);
}

/**
 * handleIntent({ buyerId, rawIntent, merchantId })
 *
 * Step 1 of the flow: resolve intent -> evaluate policy -> log -> return
 * a decision. Does NOT call Razorpay yet, even on AUTO_APPROVE — see
 * executeApprovedAction for why that's a separate step.
 */
export function handleIntent({ buyerId, rawIntent, merchantId = "brewcycle" }) {
  const db = getDb();
  try {
    const sessionId = createSession(db, { buyerId, intent: rawIntent });

    const resolution = resolveIntent(rawIntent);
    if (!resolution.matched) {
      logAudit(db, {
        sessionId,
        actor: "merchantguard",
        action: "RESOLVE_INTENT",
        input: { rawIntent },
        decision: "REJECT",
        reason: "Could not resolve intent to a known product.",
        checks: [{ rule: "intent_resolved", expected: true, actual: false, result: "FAIL" }],
      });
      updateSessionStatus(db, sessionId, "rejected");
      return { sessionId, decision: "REJECT", reason: "Could not resolve intent to a known product." };
    }

    const quantity = extractQuantity(rawIntent);
    const { product } = resolution;

    const { decision, checks, totalAmountPaise } = evaluate({
      product,
      quantity,
      buyerId,
      merchantId,
    });

    logAudit(db, {
      sessionId,
      actor: "merchantguard",
      action: "EVALUATE_POLICY",
      input: { rawIntent, sku: product.sku, quantity },
      decision,
      reason: decisionReason(decision, checks),
      checks,
      amountPaise: totalAmountPaise,
    });

    const statusMap = {
      AUTO_APPROVE: "approved",
      HUMAN_APPROVAL: "pending_approval",
      REJECT: "rejected",
    };
    updateSessionStatus(db, sessionId, statusMap[decision]);

    return {
      sessionId,
      decision,
      checks,
      product,
      quantity,
      totalAmountPaise,
      reason: decisionReason(decision, checks),
    };
  } finally {
    db.close();
  }
}

/**
 * executeApprovedAction(sessionId)
 *
 * Step 2 of the flow: actually call Razorpay MCP. Only called for
 * sessions that are 'approved' (AUTO_APPROVE) or have just been
 * manually approved by a human (HUMAN_APPROVAL -> merchant clicked
 * Approve).
 *
 * REVALIDATION NOTE: this function re-fetches the product row and
 * re-runs the policy evaluator RIGHT NOW, using current data — it does
 * NOT reuse the decision computed in handleIntent. If the merchant
 * changed the price (or deactivated the product, or another purchase
 * pushed the buyer over the velocity limit) in the time between
 * resolution and execution, this catches it and blocks execution
 * instead of charging against stale state. This is the single most
 * important correctness property in the whole system: authorization
 * must be evaluated against the state being transacted, not merely
 * the state discovered earlier.
 */
export async function executeApprovedAction(sessionId) {
  const db = getDb();
  try {
    const session = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);
    if (!["approved", "pending_approval"].includes(session.status)) {
      throw new Error(`Session ${sessionId} is not in an executable state (status: ${session.status})`);
    }

    // Re-resolve from the ORIGINAL intent, not from cached earlier results,
    // then re-fetch the product fresh from the DB (not from any object
    // held in memory since handleIntent ran).
    const resolution = resolveIntent(session.intent);
    if (!resolution.matched) {
      logAudit(db, {
        sessionId,
        actor: "merchantguard",
        action: "REVALIDATE",
        decision: "REJECT",
        reason: "Product could not be re-resolved at execution time.",
      });
      updateSessionStatus(db, sessionId, "rejected");
      return { sessionId, decision: "REJECT", reason: "Product could not be re-resolved at execution time." };
    }

    const quantity = extractQuantity(session.intent);
    const freshProduct = getFreshProduct(db, resolution.product.sku);

    const revalidation = evaluate({
      product: freshProduct,
      quantity,
      buyerId: session.buyer_id,
    });

    logAudit(db, {
      sessionId,
      actor: "merchantguard",
      action: "REVALIDATE",
      input: { sku: freshProduct.sku, quantity },
      decision: revalidation.decision,
      reason: decisionReason(revalidation.decision, revalidation.checks),
      checks: revalidation.checks,
      amountPaise: revalidation.totalAmountPaise,
    });

    if (revalidation.decision === "REJECT") {
      updateSessionStatus(db, sessionId, "rejected");
      return {
        sessionId,
        decision: "REJECT",
        reason: "Revalidation at execution time failed — state changed since original approval.",
        checks: revalidation.checks,
      };
    }

    // reference_id must be globally unique on RAZORPAY'S side, not just
    // locally — Razorpay remembers every reference_id forever, but our
    // local session IDs reset to 1 every time the DB is re-initialized
    // (npm run init-db). Using session ID alone caused real collisions
    // during testing (mg-session-2 already existed remotely from an
    // earlier local run). A short random suffix makes each attempt
    // unique regardless of local DB state.
    const mcpResult = await createPaymentLink({
      amountPaise: revalidation.totalAmountPaise,
      description: `${freshProduct.name} x${quantity} — MerchantGuard session ${sessionId}`,
      referenceId: `mg-session-${sessionId}-${randomUUID().slice(0, 8)}`,
    });

    logAudit(db, {
      sessionId,
      actor: "merchantguard",
      action: "EXECUTE_PURCHASE",
      decision: mcpResult.success ? "EXECUTED" : "EXECUTION_FAILED",
      reason: mcpResult.success ? "Payment link created." : mcpResult.error,
      amountPaise: revalidation.totalAmountPaise,
      mcpTool: mcpResult.tool,
      result: mcpResult.result ?? { error: mcpResult.error },
    });

    updateSessionStatus(db, sessionId, mcpResult.success ? "executed" : "execution_failed");

    return {
      sessionId,
      decision: mcpResult.success ? "EXECUTED" : "EXECUTION_FAILED",
      mcpResult,
      amountPaise: revalidation.totalAmountPaise,
    };
  } finally {
    db.close();
  }
}

function decisionReason(decision, checks) {
  const failed = checks.filter((c) => c.result === "FAIL").map((c) => c.rule);
  if (decision === "REJECT") {
    return failed.length
      ? `Rejected — failed rule(s): ${failed.join(", ")}`
      : "Rejected.";
  }
  if (decision === "HUMAN_APPROVAL") {
    return "Amount exceeds auto-approval threshold — routed for human approval.";
  }
  return "All policy checks passed — auto-approved.";
}
