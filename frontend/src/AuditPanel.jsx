import { useEffect, useState } from "react";
import { getAuditTrail } from "./api.js";
import ChecksTable from "./ChecksTable.jsx";

export default function AuditPanel({ sessionId, refreshSignal }) {
  const [trail, setTrail] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (sessionId == null) return;
    getAuditTrail(sessionId)
      .then(setTrail)
      .catch((err) => setError(err.message));
  }, [sessionId, refreshSignal]);

  return (
    <div className="panel audit-panel">
      <h2>Audit Trail</h2>
      <p className="panel-subtitle">
        {sessionId != null ? `Session #${sessionId}` : "Select a session to view its history"}
      </p>

      {error && <p className="error">⚠ {error}</p>}

      {sessionId == null ? (
        <p className="empty-state">Send a purchase request to see its audit trail here.</p>
      ) : (
        <div className="audit-log">
          {trail.map((entry) => (
            <div key={entry.id} className="audit-entry">
              <div className="audit-entry-header">
                <span className="audit-actor">{entry.actor}</span>
                <span className="audit-action">{entry.action}</span>
                {entry.decision && (
                  <span className={`decision-badge badge-${entry.decision.toLowerCase()}`}>
                    {entry.decision}
                  </span>
                )}
              </div>
              {entry.reason && <p className="audit-reason">{entry.reason}</p>}
              {entry.checks && <ChecksTable checks={entry.checks} />}
              {entry.mcp_tool && (
                <p className="audit-mcp">MCP tool called: <code>{entry.mcp_tool}</code></p>
              )}
              <span className="audit-timestamp">
                {new Date(entry.timestamp * 1000).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
