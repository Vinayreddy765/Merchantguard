export default function ChecksTable({ checks }) {
  if (!checks || checks.length === 0) return null;

  return (
    <div className="checks-table">
      {checks.map((c, i) => (
        <div key={i} className={`check-row check-${c.result?.toLowerCase()}`}>
          <span className="check-icon">{c.result === "PASS" ? "✓" : "✗"}</span>
          <span className="check-rule">{formatRule(c.rule)}</span>
          <span className="check-values">
            expected <code>{formatValue(c.expected)}</code> · actual{" "}
            <code>{formatValue(c.actual)}</code>
          </span>
        </div>
      ))}
    </div>
  );
}

function formatRule(rule) {
  return rule.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
