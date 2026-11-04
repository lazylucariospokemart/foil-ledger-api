# Foil Ledger API — Runbook (plain words)

A tiny web service that sells your Pokémon card prices to other people's bots,
a fraction of a cent per call, paid in USDC. It runs on your Cloudflare account,
reads prices from the vault repo (already refreshed daily), and keeps a referral
ledger so anyone who sends you traffic earns a cut.

You do the three things only you can do (accounts, wallet address, pressing Deploy).
Everything else is in this folder.

---

## Part A — Testnet (free money, no risk). ~20 minutes.

**1. Get a receiving wallet address.**
Any wallet that works on Base: Coinbase Wallet app is the easiest. Copy the
address (starts with `0x`, 42 characters). That's the *public* address — it's fine
to share. Never type a seed phrase or private key anywhere in this project.

**2. Open a terminal in this folder.** (Right-click the folder → "Open in Terminal".)

```
npm install
npx wrangler login
```
A browser tab opens; approve it. That links the folder to your Cloudflare account.

**3. Make the ledger storage.**
```
npx wrangler kv namespace create LEDGER
```
It prints an `id = "...."` line. Open `wrangler.toml` and paste that id where it
says `PASTE_KV_ID_HERE`.

**4. Set your payout address as a secret.**
```
npx wrangler secret put PAY_TO
```
Paste the `0x...` address when it asks. (Secrets live in Cloudflare, not in files.)

**5. Deploy.**
```
npm run deploy
```
It prints your URL: `https://foil-ledger-api.<something>.workers.dev`.
Open it in a browser — you should see the JSON menu. Open `/v1/health` — card count
and freshness. Open `/v1/movers` — you should see a payment page (that's the 402).

**6. Make a test purchase (optional but satisfying).**
Make a *second* throwaway wallet, export its private key (test wallet only!),
fund it from the Circle faucet (https://faucet.circle.com → Base Sepolia → USDC)
and a Base Sepolia ETH faucet, then:
```
set TEST_PRIVATE_KEY=0x...
set API=https://foil-ledger-api.<something>.workers.dev
set REF=0xYourReceivingAddressFromStep1
npm test
```
You should get status 200 and the movers JSON. Then open
`/v1/referrals/<REF address>` — calls should be 1.

---

## Part B — Mainnet (real USDC). Do this only after Part A works.

1. Coinbase Developer Platform account: https://portal.cdp.coinbase.com → create a
   project → create an API key. You get a **key id** and a **key secret**.
2. In `wrangler.toml`, change:
   - `NETWORK = "eip155:8453"`
   - `FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402"`
3. Add the secrets:
   ```
   npx wrangler secret put CDP_API_KEY_ID
   npx wrangler secret put CDP_API_KEY_SECRET
   ```
4. `npm run deploy` again. Done — payments now land as real USDC on Base at your address.

---

## Prices and the referral cut

Prices are at the top of `src/index.ts` (`PRICES`). Referral percentage is
`REFERRAL_PCT` in `wrangler.toml` (10 = 10%). Change, then `npm run deploy`.

**How referrals work (v1):** anyone who adds `?ref=0xTheirWallet` to a paid call gets
that call logged under their address. `/v1/referrals/0x...` shows calls, gross and
owed. You pay them out weekly by sending USDC from your wallet (the factory will
produce the list). v2 is an on-chain split so it's automatic — not needed until
someone actually earns more than a few dollars.

---

## If something breaks

- `npx wrangler tail` streams live logs from the deployed Worker.
- "Failed to fetch supported kinds from facilitator" at startup = the facilitator
  URL is wrong for the network (testnet URL with mainnet network, or vice versa).
- 402 page shows but paying fails = the buyer wallet has no USDC/gas on that network.
- No cards / stale prices = the vault repo's price workflow didn't run; `/v1/health`
  shows `pricesAsOf`.

Nothing here can spend your money: the Worker only *receives*.
