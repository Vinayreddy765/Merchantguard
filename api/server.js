/**
 * server.js
 *
 * Thin HTTP layer over the risk gate. The frontend (chat UI + merchant
 * dashboard) talks to this, never to the policy engine or MCP client
 * directly. Keeping this layer thin is deliberate — all real decision
 * logic lives in policy-engine/, this file just exposes it over HTTP.
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { handleIntent, executeApprovedAction } from "../policy-engine/risk-gate.js";
import { getDb, getAuditTrail, listSessions, getSession } from "../policy-engine/audit-logger.js";

const app = express();
app.use(cors());
app.use(express.json());

/**
 * POST /api/intent
 * body: { buyerId: string, rawIntent: string }
 *
 * Runs resolve -> policy evaluate -> log. If the decision is
 * AUTO_APPROVE, ALSO executes immediately (calls Razorpay MCP) since
 * no human step is needed. If HUMAN_APPROVAL, the session sits pending
 * until POST /api/sessions/:id/approve is called. If REJECT, nothing
 * further happens.
 */
app.post("/api/intent", async (req, res) => {
  const { buyerId, rawIntent } = req.body;
  if (!buyerId || !rawIntent) {
    return res.status(400).json({ error: "buyerId and rawIntent are required" });
  }

  try {
    const result = handleIntent({ buyerId, rawIntent });

    if (result.decision === "AUTO_APPROVE") {
      const exec = await executeApprovedAction(result.sessionId);
      return res.json({ ...result, execution: exec });
    }

    return res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:id/approve
 * Merchant clicks "Approve" on a pending HUMAN_APPROVAL session.
 * Triggers revalidation + execution (see risk-gate.js REVALIDATION NOTE).
 */
app.post("/api/sessions/:id/approve", async (req, res) => {
  const sessionId = Number(req.params.id);
  try {
    const exec = await executeApprovedAction(sessionId);
    res.json(exec);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sessions/:id/reject
 * Merchant clicks "Reject" on a pending HUMAN_APPROVAL session.
 * No MCP call — just marks the session rejected with an audit entry.
 */
app.post("/api/sessions/:id/reject", (req, res) => {
  const sessionId = Number(req.params.id);
  const db = getDb();
  try {
    const session = getSession(db, sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    db.prepare(`UPDATE agent_sessions SET status = 'rejected' WHERE id = ?`).run(sessionId);
    db.prepare(`
      INSERT INTO audit_logs (session_id, actor, action, decision, reason, timestamp)
      VALUES (?, 'merchant_human', 'MANUAL_REJECT', 'REJECT', 'Rejected by merchant.', ?)
    `).run(sessionId, Math.floor(Date.now() / 1000));

    res.json({ sessionId, decision: "REJECT", reason: "Rejected by merchant." });
  } finally {
    db.close();
  }
});

/** GET /api/sessions?status=pending_approval — list sessions, optionally filtered */
app.get("/api/sessions", (req, res) => {
  const db = getDb();
  try {
    const sessions = listSessions(db, { status: req.query.status || null });
    res.json(sessions);
  } finally {
    db.close();
  }
});

/** GET /api/sessions/:id/audit — full audit trail for one session */
app.get("/api/sessions/:id/audit", (req, res) => {
  const db = getDb();
  try {
    const trail = getAuditTrail(db, Number(req.params.id)).map((row) => ({
      ...row,
      input: row.input ? JSON.parse(row.input) : null,
      checks: row.checks ? JSON.parse(row.checks) : null,
      result: row.result ? JSON.parse(row.result) : null,
    }));
    res.json(trail);
  } finally {
    db.close();
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ MerchantGuard API running on http://localhost:${PORT}`);
});
