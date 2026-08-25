import { useState } from "react";
import ChatPanel from "./ChatPanel.jsx";
import ApprovalsPanel from "./ApprovalsPanel.jsx";
import AuditPanel from "./AuditPanel.jsx";
import "./app.css";

const BUYER_ID = "demo_buyer";

export default function App() {
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  function handleSessionCreated(sessionId) {
    setActiveSessionId(sessionId);
    setRefreshSignal((n) => n + 1);
  }

  function handleDecided(sessionId) {
    setActiveSessionId(sessionId);
    setRefreshSignal((n) => n + 1);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>MerchantGuard</h1>
        <p>A policy gateway for agentic commerce — BrewCycle demo</p>
      </header>

      <main className="app-grid">
        <ChatPanel buyerId={BUYER_ID} onSessionCreated={handleSessionCreated} />
        <ApprovalsPanel refreshSignal={refreshSignal} onDecided={handleDecided} />
        <AuditPanel sessionId={activeSessionId} refreshSignal={refreshSignal} />
      </main>
    </div>
  );
}
