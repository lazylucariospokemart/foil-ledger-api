/**
 * Browser MCP test buyer. Runs in a tab on the API's own origin.
 * Reads the throwaway wallet key from a local file the user picks (never leaves the tab),
 * then calls paid MCP tools over streamable HTTP with automatic x402 payment.
 * Exposes window.mcpBuyer = { loadKeyFile(file), address, call(tool, args) }.
 */
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount } from "viem/accounts";

let client: any = null;
let address = "";

async function loadKeyFile(file: File) {
  const txt = await file.text();
  const m = txt.match(/0x[0-9a-fA-F]{64}/);
  if (!m) throw new Error("no private key found in file");
  const account = privateKeyToAccount(m[0] as `0x${string}`);
  address = account.address;
  client = createx402MCPClient({
    name: "foil-ledger-test-buyer", version: "1.0.0",
    schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
    autoPayment: true,
  });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.origin)));
  return address;
}

async function call(tool: string, args: Record<string, unknown> = {}) {
  if (!client) throw new Error("load key file first");
  const r = await client.callTool(tool, args);
  const text = r?.content?.[0]?.text ?? "";
  return { paymentMade: !!r?.paymentMade, tx: r?.paymentResponse?.transaction, network: r?.paymentResponse?.network, body: String(text).slice(0, 300), isError: !!r?.isError };
}

(window as any).mcpBuyer = { loadKeyFile, call, get address() { return address; } };
console.log("[mcpBuyer] ready");
