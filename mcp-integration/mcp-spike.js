/**
 * mcp-spike.js
 *
 * PURPOSE: This is the very first thing to run in this project.
 * It proves — before we build anything else — that our own backend
 * (not Claude Desktop, not Cursor) can act as an MCP client and call
 * Razorpay's official remote MCP server programmatically.
 *
 * If this script fails, MerchantGuard's whole architecture needs a
 * fallback plan (calling Razorpay's REST API directly and documenting
 * MCP-compatibility as a design target instead of a working integration).
 * So: run this FIRST, today, before writing the policy engine.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in your Razorpay TEST mode keys
 *   2. npm install
 *   3. npm run spike
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
    console.error(
      `\n❌ Missing env vars: ${missing.join(", ")}\n` +
        `   Copy .env.example to .env and fill in your Razorpay TEST mode credentials.\n`
    );
    process.exit(1);
  }
}

async function main() {
  assertEnv();

  const authHeader =
    "Basic " + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");

  console.log("→ Connecting to Razorpay MCP server:", RAZORPAY_MCP_URL);

  const transport = new StreamableHTTPClientTransport(new URL(RAZORPAY_MCP_URL), {
    requestInit: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const client = new Client(
    { name: "merchantguard-spike", version: "0.1.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log("✅ Connected to Razorpay MCP server\n");

    // Step 1: list available tools — confirms auth + protocol handshake worked
    const toolsResult = await client.listTools();
    console.log(`✅ Tool discovery succeeded. ${toolsResult.tools.length} tools available.\n`);
    console.log("First 10 tools:");
    toolsResult.tools.slice(0, 10).forEach((t) => {
      console.log(`   - ${t.name}: ${t.description?.slice(0, 80) ?? ""}`);
    });

    // Step 2: find and call create_payment_link with a small TEST amount.
    // This is the real proof — an actual tool CALL, not just discovery.
    const createLinkTool = toolsResult.tools.find((t) =>
      t.name.toLowerCase().includes("payment_link")
    );

    if (!createLinkTool) {
      console.warn(
        "\n⚠️  Could not find a payment_link tool by name — check the tool list above " +
          "and adjust this script to call the correct tool name."
      );
      return;
    }

    console.log(`\n→ Calling tool: ${createLinkTool.name}`);
    const callResult = await client.callTool({
      name: createLinkTool.name,
      arguments: {
        amount: 100, // ₹1.00 in paise — smallest possible test amount
        currency: "INR",
        description: "MerchantGuard MCP spike — connectivity test",
      },
    });

    console.log("\n✅ Tool call succeeded. Result:");
    console.log(JSON.stringify(callResult, null, 2));

    console.log(
      "\n🎉 SPIKE PASSED: our backend can call Razorpay MCP tools directly.\n" +
        "   Safe to proceed with building the policy engine on top of this client.\n"
    );
  } catch (err) {
    console.error("\n❌ SPIKE FAILED:", err.message);
    console.error(
      "\nNext step: fall back to calling Razorpay's REST API directly, and document\n" +
        "MCP-compatibility as the intended execution layer in the README, with this\n" +
        "script + error as evidence of what was attempted.\n"
    );
    console.error(err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
