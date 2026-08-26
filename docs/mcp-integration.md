# MCP Integration

This document explains exactly how MerchantGuard connects to Razorpay's
MCP server, why that connection is structured the way it is, and what
happens when it isn't available. Every claim below is backed by code
in this repo and was verified against Razorpay's real test-mode
infrastructure, not simulated.

```
Why MCP?
   ↓
How MerchantGuard connects
   ↓
Authentication
   ↓
Tool discovery
   ↓
Tool invocation
   ↓
What happens when MCP is unavailable
   ↓
Fallback behavior
```

## Why MCP

Razorpay ships an official remote MCP server
(`https://mcp.razorpay.com/mcp`) that exposes 40+ payment operations —
`create_order`, `create_payment_link`, `capture_payment`,
`fetch_all_payments`, and others — as MCP tools any client can call.
Building a parallel REST integration against Razorpay's normal API
would work, but it would mean MerchantGuard is not actually plugged
into the interface Razorpay has built specifically for AI-agent
consumption. Using MCP directly means the execution layer of this
project is the same interface a real AI buyer agent (ChatGPT, Claude,
or any other MCP-aware system) would use to transact with a Razorpay
merchant — so MerchantGuard's policy layer sits in a position that
actually matters in the real agentic-commerce stack, not a simulated
one.

## How MerchantGuard connects

MerchantGuard acts as an **MCP client**, not an MCP server. This is an
important distinction: Razorpay's MCP server is usually configured
inside AI coding tools (Claude Desktop, Cursor) so *they* can call
Razorpay tools on a developer's behalf. MerchantGuard instead connects
to that same server from its own backend code, using the official
`@modelcontextprotocol/sdk` TypeScript/JavaScript client
(`mcp-integration/razorpay-mcp-client.js`), so that *MerchantGuard's
policy engine* — not a human developer, not an unrestricted AI
assistant — is the thing deciding when a tool call is allowed to fire.

```js
const transport = new StreamableHTTPClientTransport(new URL(RAZORPAY_MCP_URL), {
  requestInit: { headers: { Authorization: authHeader } },
});
const client = new Client({ name: "merchantguard", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);
```

`StreamableHTTPClientTransport` is the MCP SDK's HTTP-based transport
— this is what lets a normal Node.js backend, rather than a desktop AI
tool, act as an MCP client over the network.

## Authentication

Razorpay's MCP server authenticates with HTTP Basic Auth, using the
same Key ID / Key Secret pair issued for normal API access
(Dashboard → Settings → API Keys, generated in **test mode**):

```js
const authHeader =
  "Basic " + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
```

Credentials are read from environment variables (`.env`, never
committed — see `.gitignore`) and validated before any connection
attempt (`assertEnv()` in `razorpay-mcp-client.js`), so a missing key
fails fast with a clear message rather than a confusing network error.

## Tool discovery

Before calling anything, MerchantGuard asks the server what tools
exist:

```js
const toolsResult = await client.listTools();
```

This was the first thing verified in this project, before any policy
logic was written (`mcp-integration/mcp-spike.js`, run on day one of
the build). That spike confirmed **42 tools** are exposed by Razorpay's
live server, including `create_payment_link`, `create_order`,
`capture_payment`, `create_registration_link`, and
`fetch_all_payments`. MerchantGuard currently uses `create_payment_link`
for executing approved purchases; the tool discovery step means adding
support for another tool (e.g. `create_order` for a different
transaction shape) requires no protocol-level changes, only finding
the tool by name in the discovered list.

## Tool invocation

Only one function in the entire codebase is allowed to call a
Razorpay tool: `createPaymentLink()` in
`mcp-integration/razorpay-mcp-client.js`. It is called from exactly
one place — `executeApprovedAction()` in `policy-engine/risk-gate.js`
— and only after that function has re-validated the policy decision
against current state (see `docs/failure-analysis.md`).

```js
const callResult = await client.callTool({
  name: "create_payment_link",
  arguments: { amount: amountPaise, currency: "INR", description, reference_id: referenceId },
});
```

This was exercised for real, twice, with two different policy paths:

- **AUTO_APPROVE path**: "Subscribe me to Premium Coffee for
  ₹1,299/month" → executed immediately → real payment link
  `rzp.io/rzp/ZTUVh6p`
- **HUMAN_APPROVAL path**: "Buy the 3-month Premium plan" (₹3,597) →
  routed to merchant approval → approved → executed → real payment
  link `rzp.io/rzp/z2CQFvk1`

Both are real Razorpay test-mode payment links generated during
development of this repo, not mocked responses.

## What happens when MCP is unavailable

`createPaymentLink()` wraps the entire connect → discover → call
sequence in a try/catch and never throws to its caller:

```js
export async function createPaymentLink({ amountPaise, description, referenceId }) {
  try {
    /* ... */
    return { success: true, tool: tool.name, result: callResult, error: null };
  } catch (err) {
    return { success: false, tool: "create_payment_link", result: null, error: err.message };
  }
}
```

This was not a hypothetical path — it happened during real testing,
twice, for two different real reasons:

1. **Missing credentials.** Running the flow without a valid `.env`
   surfaces `Missing env vars: RAZORPAY_KEY_ID, ...` as a clean,
   returned error rather than an unhandled exception.
2. **`reference_id` collision** (a real bug, not staged — see
   `docs/failure-analysis.md`). Razorpay's server rejected a call with
   `"payment link with given reference_id: mg-session-2 already
   exists"`. Because `createPaymentLink()` returns a structured
   failure instead of throwing, this error was captured, logged to the
   audit trail (`EXECUTE_PURCHASE` / `EXECUTION_FAILED`), and shown to
   the user cleanly — the whole system stayed up and explainable
   instead of crashing.

## Fallback behavior

When `createPaymentLink()` returns `success: false`, the caller
(`executeApprovedAction()` in `risk-gate.js`) does three things:

1. Logs the failure to `audit_logs` with `decision: EXECUTION_FAILED`
   and the real error message, so the failure is queryable and visible
   in the audit trail UI, not hidden.
2. Updates the session status to `execution_failed`, distinct from
   `rejected` — this failure happened *after* policy approval, at the
   execution layer, which is a meaningfully different event from a
   policy-based rejection and is recorded as such.
3. Returns the failure to the HTTP layer (`api/server.js`), which the
   frontend renders as a visible, readable error
   (`ExecutionResult` component in `frontend/src/ChatPanel.jsx`) rather
   than a blank state or a crash.

No retry-and-hide-the-error logic exists on purpose: a failed money
action should be visible, not silently retried into a possibly
different outcome than what was originally evaluated.
