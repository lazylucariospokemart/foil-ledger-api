# Where to post it

The Worker declares itself to **Bazaar** (x402's discovery index) automatically after the
first paid mainnet call. Beyond that, two posts are worth making. Paste-ready text below.
The GitHub README is already the landing page; link to it, not the raw API URL.

Repo: https://github.com/lazylucariospokemart/foil-ledger-api
API:  https://foil-ledger-api.lazylucariospokemart28.workers.dev

---

## 1. x402 Discord — #showcase

> **Foil Ledger API** — I run a Pokémon card shop (Whatnot seller). The price feed that
> runs my storefront is now behind x402 on Base: condition-aware TCGplayer-based prices
> for the ~200 cards I actually hold and sell, refreshed daily, with 7-day movers.
> $0.002–$0.01 a call, USDC, no keys.
>
> Two things I haven't seen others do that I'd love feedback on:
> • It's a *real business's* live data, not a wrapper around a public API.
> • **10% referral split** on every call, forever, to whoever routes traffic — just add
> `?ref=0xWallet`. Thinking of it as affiliate marketing for agents. One level, sales only.
>
> Free sample endpoint so you can see the shape before paying.
> Repo + docs: https://github.com/lazylucariospokemart/foil-ledger-api

---

## 2. One post for X / Reddit (r/x402, r/ethdev, r/PokemonTCG dev threads)

> I put my card shop's live Pokémon price feed behind x402. Agents can buy prices by the
> call — fractions of a cent, USDC on Base, no account. 10% referral cut to anyone who
> sends traffic. Free sample endpoint. https://github.com/lazylucariospokemart/foil-ledger-api

---

## What NOT to do

- No ads. The buyers are developers and their bots; they find things through Bazaar,
  GitHub and Discord.
- Never call it a token, coin, or investment. It's an API.
- Don't promise uptime. "Best effort, refreshed daily" is honest and the README says so.
- Don't reply to "how much have you made" with a number you can't see; `/v1/referrals`
  and the KV ledger are the source of truth.
