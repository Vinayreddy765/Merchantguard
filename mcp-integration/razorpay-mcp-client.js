/**
 * razorpay-mcp-client.js
 *
 * Reusable wrapper around Razorpay's MCP server, extracted from the
 * Day 1 spike script (mcp-spike.js) now that connectivity is confirmed
 * working. This is the ONLY module in the whole project allowed to
 * talk to Razorpay — the risk gate calls into this, never the other
 * way around.
 */

import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_MCP_URL } = process.env;

function assertEnv() {
  const missing = [];
  if (!RAZORPAY_KEY_ID) missing.push("RAZORPAY_KEY_ID");
  if (!RAZORPAY_KEY_SECRET) missing.push("RAZORPAY_KEY_SECRET");
  if (!RAZORPAY_MCP_URL) missing.push("RAZORPAY_MCP_URL");
  if (missing.length) {
    throw new Error(
      `Missing env vars: ${missing.join(", ")}. Copy .env.example to .env and fill in your Razorpay TEST mode credentials.`
    );
  }
}

async function withClient(fn) {
  assertEnv();
  const authHeader =
    "Basic " + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");

  const transport = new StreamableHTTPClientTransport(new URL(RAZORPAY_MCP_URL), {
    requestInit: { headers: { Authorization: authHeader } },
  });
  const client = new Client({ name: "merchantguard", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

/**
 * createPaymentLink({ amountPaise, description, referenceId })
 * -> { success: boolean, tool: string, result: object|null, error: string|null }
 *
 * This is the ONLY function that executes real money-movement (test
 * mode) on Razorpay. It should only ever be called after a policy
 * decision of AUTO_APPROVE, or HUMAN_APPROVAL + explicit merchant
 * approval — never directly from the resolver or evaluator.
 */
export async function createPaymentLink({ amountPaise, description, referenceId }) {
  try {
    return await withClient(async (client) => {
      const toolsResult = await client.listTools();
      const tool = toolsResult.tools.find((t) => t.name === "create_payment_link");
      if (!tool) throw new Error("create_payment_link tool not found on MCP server");

      const callResult = await client.callTool({
        name: tool.name,
        arguments: {
          amount: amountPaise,
          currency: "INR",
          description,
          reference_id: referenceId,
        },
      });

      return { success: true, tool: tool.name, result: callResult, error: null };
    });
  } catch (err) {
    return { success: false, tool: "create_payment_link", result: null, error: err.message };
  }
}
