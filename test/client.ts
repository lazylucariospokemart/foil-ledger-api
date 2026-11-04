/**
 * Test buyer: pays for one call with a Base Sepolia test wallet.
 *
 *   TEST_PRIVATE_KEY=0x... API=https://foil-ledger-api.<you>.workers.dev npm test
 *
 * The wallet needs a little Base Sepolia ETH (for gas) and test USDC:
 *   faucet: https://faucet.circle.com  (pick Base Sepolia, USDC)
 * Never use a real-money key here.
 */
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const API = process.env.API ?? "http://localhost:8787";
const key = process.env.TEST_PRIVATE_KEY;
if (!key) { console.error("Set TEST_PRIVATE_KEY (a throwaway Base Sepolia wallet)"); process.exit(1); }

const account = privateKeyToAccount(key as `0x${string}`);
const client = registerExactEvmScheme(new x402Client(), { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);

const ref = process.env.REF ?? "";
const url = `${API}/v1/movers?n=3${ref ? `&ref=${ref}` : ""}`;
console.log("buying:", url, "as", account.address);
const res = await payFetch(url);
console.log("status:", res.status);
console.log(JSON.stringify(await res.json(), null, 1).slice(0, 1500));
console.log("payment response header:", res.headers.get("payment-response") ?? res.headers.get("x-payment-response"));
