/**
 * Browser test buyer. Runs inside a tab on the API's own origin.
 * Makes a throwaway Base Sepolia wallet (kept in sessionStorage of that tab only),
 * and exposes window.buyer = { address, buy(path) }.
 * Never use with real funds.
 */
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const KEY = "foil-ledger-test-buyer-key";
let pk = sessionStorage.getItem(KEY) as `0x${string}` | null;
if (!pk) { pk = generatePrivateKey(); sessionStorage.setItem(KEY, pk); }
const account = privateKeyToAccount(pk);
const client = registerExactEvmScheme(new x402Client(), { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);

async function buy(path: string) {
  const res = await payFetch(path);
  const text = await res.text();
  let receipt: unknown = null;
  const h = res.headers.get("payment-response");
  if (h) { try { receipt = decodePaymentResponseHeader(h); } catch { receipt = h.slice(0, 80); } }
  return { status: res.status, body: text.slice(0, 600), receipt };
}

(window as any).buyer = { address: account.address, buy };
console.log("[buyer] ready", account.address);
