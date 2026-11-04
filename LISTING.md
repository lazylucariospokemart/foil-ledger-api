# Where to list it (so bots actually find it)

The Worker already declares itself to **Bazaar** (x402's discovery index) on the
`/v1/cards`, `/v1/search` and `/v1/movers` routes — that happens automatically on
the first paid call through the Coinbase facilitator (mainnet). Beyond that, three
places are worth five minutes each. Paste-ready text below; swap in your URL.

---

## 1. GitHub README (make the Worker repo public)

> # Foil Ledger API — live Pokémon TCG prices for agents
>
> Condition-aware TCGplayer-based market prices from a working card shop's
> inventory, updated daily. Pay per call in USDC via **x402** — no API key, no
> account, no subscription.
>
> | Endpoint | Price |
> |---|---|
> | `GET /v1/cards` — every tracked card, price + 7-day change | $0.005 |
> | `GET /v1/card/:id` | $0.002 |
> | `GET /v1/search?q=charizard` | $0.005 |
> | `GET /v1/movers?n=10` — biggest 7-day movers | $0.01 |
>
> Base URL: `https://foil-ledger-api.<you>.workers.dev`
> Networks: Base (eip155:8453). Scheme: exact. Any x402 client works:
>
> ```ts
> import { wrapFetchWithPayment } from "@x402/fetch";
> const res = await payFetch("https://.../v1/movers?n=5&ref=0xYOURWALLET");
> ```
>
> **Referrals:** append `?ref=0xYourWallet` and you earn 10% of every call you
> send, forever. One level, sales only, paid weekly in USDC. Check your tally at
> `/v1/referrals/0xYourWallet`.
>
> Built by [Lazy Lucario](https://lazylucariospokemart.github.io/lazy-lucario-vault/),
> a Pokémon seller on Whatnot. Data is the same feed that prices the shop.

---

## 2. x402 Discord — #showcase (or #builders)

> Shipped a small one: **Foil Ledger API** — Pokémon TCG market prices
> (condition-aware, TCGplayer-based, refreshed daily from a real card shop's
> inventory) behind x402 on Base. Four endpoints, $0.002–$0.01 per call.
> Also running a 10% referral split for any agent/dev who routes calls to it —
> just add `?ref=0xWallet`. Would love feedback from anyone building
> buyer-agents in the collectibles space. `<URL>`

---

## 3. One post each on X and the r/x402 / r/ethdev crowd

> Agents can now buy Pokémon card prices by the call. Built on x402 + Base,
> no keys, no accounts, fractions of a cent. 10% referral cut for anyone who
> sends traffic. `<URL>`

---

## What NOT to do

- Don't buy ads for this yet. The buyers are developers and their bots; they find
  things through Bazaar, GitHub and Discord, not Instagram.
- Don't call it a token, coin, or investment anywhere. It's an API.
- Don't promise uptime you can't give. "Best effort, data refreshed daily" is honest.
