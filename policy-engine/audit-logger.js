/**
 * audit-logger.js
 *
 * Thin helper around the agent_sessions and audit_logs tables.
 * Kept separate from the risk gate so the logging shape stays
 * consistent no matter which part of the flow is writing to it.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "db", "merchantguard.db");

export function getDb() {
  return new Database(DB_PATH);
}

export function createSession(db, { buyerId, intent }) {
  const info = db
    .prepare(`INSERT INTO agent_sessions (buyer_id, intent, status, created_at) VALUES (?, ?, ?, ?)`)
    .run(buyerId, intent, "pending", Math.floor(Date.now() / 1000));
  return info.lastInsertRowid;
}

export function updateSessionStatus(db, sessionId, status) {
  db.prepare(`UPDATE agent_sessions SET status = ? WHERE id = ?`).run(status, sessionId);
}

export function logAudit(db, {
  sessionId,
  actor,
  action,
  input = null,
  decision = null,
  reason = null,
  checks = null,
  amountPaise = null,
  mcpTool = null,
  result = null,
}) {
  db.prepare(`
    INSERT INTO audit_logs
      (session_id, actor, action, input, decision, reason, checks, amount_paise, mcp_tool, result, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    actor,
    action,
    input ? JSON.stringify(input) : null,
    decision,
    reason,
    checks ? JSON.stringify(checks) : null,
    amountPaise,
    mcpTool,
    result ? JSON.stringify(result) : null,
    Math.floor(Date.now() / 1000)
  );
}

export function getAuditTrail(db, sessionId) {
  return db.prepare(`SELECT * FROM audit_logs WHERE session_id = ? ORDER BY id ASC`).all(sessionId);
}

export function listSessions(db, { status = null, limit = 50 } = {}) {
  if (status) {
    return db
      .prepare(`SELECT * FROM agent_sessions WHERE status = ? ORDER BY id DESC LIMIT ?`)
      .all(status, limit);
  }
  return db.prepare(`SELECT * FROM agent_sessions ORDER BY id DESC LIMIT ?`).all(limit);
}

export function getSession(db, sessionId) {
  return db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).get(sessionId);
}
