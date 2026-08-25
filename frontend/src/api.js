const API_BASE = "http://localhost:4000/api";

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function sendIntent(buyerId, rawIntent) {
  return request("/intent", {
    method: "POST",
    body: JSON.stringify({ buyerId, rawIntent }),
  });
}

export function approveSession(sessionId) {
  return request(`/sessions/${sessionId}/approve`, { method: "POST" });
}

export function rejectSession(sessionId) {
  return request(`/sessions/${sessionId}/reject`, { method: "POST" });
}

export function listSessions(status) {
  const q = status ? `?status=${status}` : "";
  return request(`/sessions${q}`);
}

export function getAuditTrail(sessionId) {
  return request(`/sessions/${sessionId}/audit`);
}
