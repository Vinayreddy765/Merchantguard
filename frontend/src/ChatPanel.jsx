import { useState } from "react";
import { sendIntent } from "./api.js";
import ChecksTable from "./ChecksTable.jsx";

const SAMPLE_INTENTS = [
  "Subscribe me to Premium Coffee for ₹1,299/month.",
  "Buy the 3-month Premium plan.",
  "Buy a ₹10,000 gift card.",
];

export default function ChatPanel({ buyerId, onSessionCreated }) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  async function submit(intent) {
    if (!intent.trim() || loading) return;
    setLoading(true);
    setMessages((m) => [...m, { role: "buyer", text: intent }]);
    setInput("");

    try {
      const result = await sendIntent(buyerId, intent);
      setMessages((m) => [...m, { role: "system", result }]);
      onSessionCreated?.(result.sessionId);
    } catch (err) {
      setMessages((m) => [...m, { role: "error", text: err.message }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel chat-panel">
      <h2>AI Buyer</h2>
      <p className="panel-subtitle">Talking to BrewCycle as an AI purchasing agent</p>

      <div className="sample-intents">
        {SAMPLE_INTENTS.map((s) => (
          <button key={s} className="sample-btn" onClick={() => submit(s)} disabled={loading}>
            {s}
          </button>
        ))}
      </div>

      <div className="messages">
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
        {loading && <div className="message system pending">Evaluating…</div>}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a purchase request…"
          disabled={loading}
        />
        <button type="submit" disabled={loading}>Send</button>
      </form>
    </div>
  );
}

function MessageBubble({ message }) {
  if (message.role === "buyer") {
    return <div className="message buyer">{message.text}</div>;
  }
  if (message.role === "error") {
    return <div className="message error">⚠ {message.text}</div>;
  }

  const { result } = message;
  const decisionClass = result.decision?.toLowerCase();

  return (
    <div className={`message system decision-${decisionClass}`}>
      <div className="decision-header">
        <span className={`decision-badge badge-${decisionClass}`}>{result.decision}</span>
        {result.product && <span className="product-name">{result.product.name}</span>}
        {result.totalAmountPaise != null && (
          <span className="amount">₹{(result.totalAmountPaise / 100).toFixed(2)}</span>
        )}
      </div>
      <p className="decision-reason">{result.reason}</p>
      <ChecksTable checks={result.checks} />
      {result.execution && (
        <ExecutionResult execution={result.execution} />
      )}
      {result.decision === "HUMAN_APPROVAL" && (
        <p className="pending-note">→ Sent to merchant for approval (see Pending Approvals panel)</p>
      )}
    </div>
  );
}

function ExecutionResult({ execution }) {
  if (execution.decision !== "EXECUTED") {
    return <p className="execution-failed">Execution failed: {execution.mcpResult?.error}</p>;
  }
  const text = execution.mcpResult?.result?.content?.[0]?.text;
  let shortUrl = null;
  try {
    shortUrl = text ? JSON.parse(text).short_url : null;
  } catch {
    /* ignore parse errors, fall back to raw text */
  }
  return (
    <p className="execution-success">
      ✅ Payment link created:{" "}
      {shortUrl ? (
        <a href={shortUrl} target="_blank" rel="noreferrer">{shortUrl}</a>
      ) : (
        "see audit trail"
      )}
    </p>
  );
}
