# Foil Ledger API

**Live Pokémon TCG prices from a real card shop's shelf, sold by the call.**
Pay with USDC on Base via [x402](https://docs.x402.org). No API key, no account, no subscription.

```
https://foil-ledger-api.lazylucariospokemart28.workers.dev
```

## What it is (and isn't)

This is the price feed behind [Lazy Lucario's storefront](https://lazylucariospokemart.github.io/lazy-lucario-vault/), a Pokémon seller on Whatnot. Every card the shop tracks gets a **condition-aware** TCGplayer-based market price, refreshed daily, with 7-day change.

It is **not** the whole Pokémon market. It's ~200 cards at any time: the ones a working seller is actually buying, holding, and selling. If you want "every card ever printed," use TCGplayer directly. If you want a signal for what's *moving on a real seller's shelf*, this is that.

## Try it free

```
GET /v1/sample     → 3 real cards, full response shape
GET /v1/health     → card count + network
```

Example (`/v1/sample`):

```json
{
  "note": "Free sample. Full data is pay-per-call; see / for prices.",
  "count": 190,
  "cards": [
    {
      "id": "194",
      "name": "N's PP Up - 262/217",
      "set": "ME: Ascended Heroes",
      "number": "262/217",
      "cond": "NM",
      "printing": "Holofoil",
      "rarity": "Ultra Rare",
      "language": "English",
      "price": 2.05,
      "chg7": 40.41,
      "priceAt": "2026-11-03T14:35:10Z",
      "kind": "single"
    }
  ]
}
```

## Paid endpoints

| Endpoint | Price | Returns |
|---|---|---|
| `GET /v1/cards` | $0.005 | Every tracked card with price + 7-day change |
| `GET /v1/card/:id` | $0.002 | One card |
| `GET /v1/search?q=charizard` | $0.005 | Name/set search, up to 100 hits |
| `GET /v1/movers?n=10` | $0.01 | Biggest 7-day movers, up and down |

Network: Base mainnet (`eip155:8453`). Scheme: `exact`. Asset: USDC.
Any x402 client works; with the official one:

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = registerExactEvmScheme(new x402Client(), { signer: privateKeyToAccount(KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("https://foil-ledger-api.lazylucariospokemart28.workers.dev/v1/movers?n=5&ref=0xYOURWALLET");
console.log(await res.json());
```

## Use it as MCP tools (for agents)

The same data is exposed as an MCP server at **`/mcp`** (streamable HTTP, stateless).
Add it to Claude, Cursor, or any MCP-capable agent and the tools appear in its tool list;
each paid call is settled with x402 (USDC on Base) automatically by an x402-aware client.

```
https://foil-ledger-api.lazylucariospokemart28.workers.dev/mcp
```

| Tool | Price | Returns |
|---|---|---|
| `health` | free | card count, freshness, network |
| `get_sample` | free | 3 real cards (response shape) |
| `get_card_price` `{id}` | $0.002 | one card |
| `search_cards` `{q}` | $0.005 | name/set search |
| `get_movers` `{n}` | $0.01 | biggest 7-day movers |
| `get_all_cards` | $0.005 | every tracked card |

Client side with the official SDK:

```ts
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = createx402MCPClient({
  name: "my-agent", version: "1.0.0",
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
  autoPayment: true,
});
await client.connect(new StreamableHTTPClientTransport(new URL("https://foil-ledger-api.lazylucariospokemart28.workers.dev/mcp")));
const res = await client.callTool("get_movers", { n: 5 });
```

## Referrals: 10% of every call you send, forever

Append `?ref=0xYourWallet` to any paid call. Every settled payment with your address on it credits you **10%**, paid weekly in USDC. One level. Sales only, never signups.

Check your tally any time (free): `GET /v1/referrals/0xYourWallet`

If you're building a buyer-agent, a price tool, or a Discord bot that pulls card prices, this is your cut for routing through here.

## Honest notes

- Best effort. Prices refresh once a day from the shop's own pipeline. If the pipeline hiccups, `/v1/health` tells you how fresh the data is.
- Prices are market reference (TCGplayer-based), not the shop's asking prices.
- Listed on Bazaar (x402 discovery) on the `/v1/cards`, `/v1/search` and `/v1/movers` routes.

## Run your own

[RUNBOOK.md](RUNBOOK.md). Cloudflare Workers, one KV namespace, your wallet address as a secret. MIT.
