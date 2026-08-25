import { useEffect, useState, useCallback } from "react";
import { listSessions, approveSession, rejectSession } from "./api.js";

export default function ApprovalsPanel({ refreshSignal, onDecided }) {
  const [pending, setPending] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const sessions = await listSessions("pending_approval");
      setPending(sessions);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  async function handleApprove(id) {
    setBusyId(id);
    try {
      await approveSession(id);
      await load();
      onDecided?.(id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id) {
    setBusyId(id);
    try {
      await rejectSession(id);
      await load();
      onDecided?.(id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="panel approvals-panel">
      <h2>Merchant Dashboard</h2>
      <p className="panel-subtitle">Pending actions requiring human approval</p>

      {error && <p className="error">⚠ {error}</p>}

      {pending.length === 0 ? (
        <p className="empty-state">No pending approvals.</p>
      ) : (
        pending.map((s) => (
          <div key={s.id} className="approval-card">
            <div className="approval-header">
              <span className="session-id">Session #{s.id}</span>
              <span className="buyer-id">Buyer: {s.buyer_id}</span>
            </div>
            <p className="approval-intent">"{s.intent}"</p>
            <div className="approval-actions">
              <button
                className="approve-btn"
                disabled={busyId === s.id}
                onClick={() => handleApprove(s.id)}
              >
                {busyId === s.id ? "…" : "Approve"}
              </button>
              <button
                className="reject-btn"
                disabled={busyId === s.id}
                onClick={() => handleReject(s.id)}
              >
                {busyId === s.id ? "…" : "Reject"}
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
