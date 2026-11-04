/**
 * Foil Ledger API — Pokémon TCG prices behind x402 (pay-per-call, USDC on Base).
 *
 * Data source: Lazy's public vault repo on GitHub (refreshed daily by its own workflow).
 * Payments:    x402 "exact" scheme. Testnet by default; flip NETWORK + FACILITATOR_URL for mainnet.
 * Referrals:   add ?ref=0xYourWallet to any paid call. Each settled payment is logged to KV
 *              against that address; referrers earn REFERRAL_PCT of every call they bring.
 *              v1 = ledger + weekly payout report (Lazy pays out). v2 = on-chain split contract.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { handleMcp, MCP_PRICES } from "./mcp";

type Env = {
  LEDGER: KVNamespace;          // referral + call ledger
  PAY_TO: string;               // Lazy's USDC receiving address (public address only)
  NETWORK?: string;             // "eip155:84532" (Base Sepolia, default) or "eip155:8453" (Base mainnet)
  FACILITATOR_URL?: string;     // testnet default https://x402.org/facilitator ; mainnet https://api.cdp.coinbase.com/platform/v2/x402
  CDP_API_KEY_ID?: string;      // only needed on mainnet (Coinbase facilitator)
  CDP_API_KEY_SECRET?: string;
  REFERRAL_PCT?: string;        // e.g. "10"
  DATA_URL?: string;
  PRICES_URL?: string;
};

const DEFAULT_DATA_URL   = "https://raw.githubusercontent.com/lazylucariospokemart/lazy-lucario-vault/main/data.json";
const DEFAULT_PRICES_URL = "https://raw.githubusercontent.com/lazylucariospokemart/lazy-lucario-vault/main/prices/latest.json";

// ---------- prices (what we sell) ----------
const PRICES = {
  cards:  "$0.005",   // full list
  card:   "$0.002",   // one card
  search: "$0.005",   // name search
  movers: "$0.01",    // top 7-day movers
};

type Card = {
  id: string; name: string; set: string; number: string; cond: string; printing?: string;
  rarity?: string; language?: string; price: number; chg7: number | null; priceAt?: string;
  kind?: string; qty?: number; sold?: boolean;
};

let cache: { at: number; cards: Card[] } | null = null;
const TTL_MS = 60 * 60 * 1000;

async function loadCards(env: Env): Promise<Card[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.cards;
  const [dataRes, pricesRes] = await Promise.all([
    fetch(env.DATA_URL ?? DEFAULT_DATA_URL, { cf: { cacheTtl: 900 } } as RequestInit),
    fetch(env.PRICES_URL ?? DEFAULT_PRICES_URL, { cf: { cacheTtl: 900 } } as RequestInit),
  ]);
  if (!dataRes.ok) throw new Error(`data.json ${dataRes.status}`);
  const data = (await dataRes.json()) as { cards: Record<string, any> };
  const prices = pricesRes.ok ? ((await pricesRes.json()) as Record<string, any>) : {};

  const cards: Card[] = Object.entries(data.cards).map(([id, c]) => {
    // prefer the daily price file when it has this card+condition
    const p = c.tcgId && prices[`${c.tcgId}|${c.cond}`];
    return {
      id, name: c.name, set: c.set, number: c.number, cond: c.cond, printing: c.printing,
      rarity: c.rarity, language: c.language,
      price: Number(p?.price ?? c.price ?? 0),
      chg7: p?.chg7 ?? c.chg7 ?? null,
      priceAt: p?.at ?? c.priceAt,
      kind: c.kind ?? "single",
      // deliberately NOT exposed: ask (Lazy's asking price), notes, qty, sold, photo, cert
    };
  });
  cache = { at: Date.now(), cards };
  return cards;
}

const pub = (c: Card) => c; // already stripped above

// ---------- app ----------
const app = new Hono<{ Bindings: Env }>();
app.use("*", cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE", "Mcp-Session-Id"], allowHeaders: ["Content-Type", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "PAYMENT-SIGNATURE", "X-PAYMENT"] }));

// MCP: the same data as paid tools for agents (Claude, Cursor, ...). Stateless streamable-HTTP.
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));

// Free: landing + docs for humans and agents
app.get("/", (c) => c.json({
  name: "Foil Ledger API",
  what: "Condition-aware Pokémon TCG market prices (TCGplayer-based, refreshed daily) for the cards a working card shop actually tracks and sells. Not the whole market: the live shelf of one seller. Pay per call with USDC via x402.",
  network: c.env.NETWORK ?? "eip155:84532",
  endpoints: {
    "GET /v1/cards":        { price: PRICES.cards,  desc: "All tracked cards with current market price and 7-day change" },
    "GET /v1/card/:id":     { price: PRICES.card,   desc: "One card by id" },
    "GET /v1/search?q=":    { price: PRICES.search, desc: "Search by card name / set" },
    "GET /v1/movers?n=10":  { price: PRICES.movers, desc: "Biggest 7-day movers, up and down" },
    "GET /v1/sample":       { price: "free",        desc: "Three real cards so you can see the response shape" },
    "GET /v1/health":       { price: "free",        desc: "Freshness + card count" },
    "GET /v1/stats":        { price: "free",        desc: "Calls and USDC earned today / last 7 days (no addresses)" },
    "GET /v1/referrals/:address": { price: "free",  desc: "Referral earnings for a wallet" },
  },
  mcp: { url: new URL("/mcp", c.req.url).toString(), transport: "streamable-http", tools: { ...MCP_PRICES, get_sample: "free", health: "free" }, note: "Same data as the REST routes, as MCP tools with x402 payment per call" },
  referrals: `Add ?ref=0xYourWallet to any paid call. You earn ${c.env.REFERRAL_PCT ?? "10"}% of every call you bring, paid out weekly in USDC. One level, sales only.`,
  docs: "https://docs.x402.org",
  owner: "Lazy Lucario — lazylucariospokemart.github.io/lazy-lucario-vault",
}));

app.get("/v1/health", async (c) => {
  const cards = await loadCards(c.env);
  const newest = cards.map((x) => x.priceAt ?? "").sort().pop();
  return c.json({ ok: true, cards: cards.length, pricesAsOf: newest, network: c.env.NETWORK ?? "eip155:84532" });
});

// Free sample: 3 real cards so buyers can see the shape before paying
app.get("/v1/sample", async (c) => {
  const cards = (await loadCards(c.env)).filter((x) => typeof x.chg7 === "number" && x.price >= 1);
  const sorted = [...cards].sort((a, b) => (b.chg7 as number) - (a.chg7 as number));
  const sample = [sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]].filter(Boolean);
  return c.json({ note: "Free sample. Full data is pay-per-call; see / for prices.", count: cards.length, cards: sample.map(pub) });
});

// Free stats for the factory Foreman: calls + USDC earned, no addresses
app.get("/v1/stats", async (c) => {
  const chi = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) { const d = new Date(chi); d.setDate(chi.getDate() - i); days.push(day(d)); }
  const rows = await Promise.all(days.map(async (k) => JSON.parse((await c.env.LEDGER.get(`day:${k}`)) ?? "null")));
  const today = rows[0] ?? { calls: 0, usd: 0, byRoute: {} };
  const last7 = rows.reduce((a, r) => r ? { calls: a.calls + r.calls, usd: +(a.usd + r.usd).toFixed(6) } : a, { calls: 0, usd: 0 });
  let owed = 0, referrers = 0;
  const list = await c.env.LEDGER.list({ prefix: "ref:" });
  for (const k of list.keys) { const r = JSON.parse((await c.env.LEDGER.get(k.name)) ?? "{}"); referrers++; owed += (r.owedUsd ?? 0) - (r.paidUsd ?? 0); }
  return c.json({ network: c.env.NETWORK ?? "eip155:84532", today: { date: days[0], calls: today.calls, usd: today.usd, byRoute: today.byRoute }, last7, referrers, referralOwedUsd: +owed.toFixed(6) });
});

app.get("/v1/referrals/:address", async (c) => {
  const addr = c.req.param("address").toLowerCase();
  const raw = await c.env.LEDGER.get(`ref:${addr}`);
  const r = raw ? JSON.parse(raw) : { calls: 0, grossUsd: 0, owedUsd: 0, paidUsd: 0 };
  return c.json({ address: addr, ...r, pct: Number(c.env.REFERRAL_PCT ?? 10) });
});

// ---------- x402 paywall on /v1/* paid routes ----------
app.use("*", async (c, next) => {
  const env = c.env;
  const network = (env.NETWORK ?? "eip155:84532") as `${string}:${string}`;
  // Mainnet: Coinbase facilitator with CDP key (secrets). Testnet: the free x402.org facilitator.
  const facilitator = env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET
    ? new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET))
    : new HTTPFacilitatorClient({ url: env.FACILITATOR_URL ?? "https://x402.org/facilitator" });

  const server = new x402ResourceServer(facilitator)
    .register(network, new ExactEvmScheme())
    // Referral ledger: runs once per settled payment
    .onAfterSettle(async (ctx) => {
      if (ctx.phase === "cancel" || !ctx.result?.success) return;
      try {
        const url = (ctx.paymentPayload as any)?.resource?.url ?? c.req.url;
        const ref = new URL(url).searchParams.get("ref")?.toLowerCase();
        const atomic = BigInt(ctx.result.amount ?? ctx.requirements.amount ?? "0");
        const usd = Number(atomic) / 1e6; // USDC has 6 decimals
        const pct = Number(env.REFERRAL_PCT ?? 10);
        const day = new Date().toISOString().slice(0, 10);

        // daily totals (for the factory dashboard)
        const dKey = `day:${day}`;
        const d = JSON.parse((await env.LEDGER.get(dKey)) ?? '{"calls":0,"usd":0,"byRoute":{}}');
        const route = new URL(url).pathname;
        d.calls++; d.usd = +(d.usd + usd).toFixed(6); d.byRoute[route] = (d.byRoute[route] ?? 0) + 1;
        await env.LEDGER.put(dKey, JSON.stringify(d), { expirationTtl: 60 * 60 * 24 * 400 });

        if (ref && /^0x[0-9a-f]{40}$/.test(ref) && ref !== (env.PAY_TO ?? "").toLowerCase()) {
          const key = `ref:${ref}`;
          const r = JSON.parse((await env.LEDGER.get(key)) ?? '{"calls":0,"grossUsd":0,"owedUsd":0,"paidUsd":0,"lastTx":""}');
          r.calls++; r.grossUsd = +(r.grossUsd + usd).toFixed(6);
          r.owedUsd = +(r.owedUsd + usd * pct / 100).toFixed(6);
          r.lastTx = ctx.result.transaction; r.lastAt = new Date().toISOString(); r.payer = ctx.result.payer;
          await env.LEDGER.put(key, JSON.stringify(r));
        }
      } catch (e) { console.error("ledger", e); }
    });

  const payTo = env.PAY_TO;
  const accept = (price: string) => [{ scheme: "exact" as const, price, network, payTo }];
  // Bazaar service metadata: shown on every listing in the x402 discovery index
  const service = {
    serviceName: "Foil Ledger API",
    tags: ["pokemon", "tcg", "prices", "collectibles", "market-data"],
    iconUrl: "https://lazylucariospokemart.github.io/lazy-lucario-vault/favicon.svg",
  };
  // A real card from the shelf (shape only; live values come from the daily price file)
  const exampleCard = {
    id: "122", name: "Pichu - 082/128", set: "Base Expansion Pack", number: "082/128", cond: "NM",
    printing: "1st Edition - Japanese", rarity: "Rare", language: "Japanese", price: 90, chg7: 33.33,
    priceAt: "2026-11-03T14:35:10Z", kind: "single",
  };
  const routes: RoutesConfig = {
    "GET /v1/cards": {
      accepts: accept(PRICES.cards), mimeType: "application/json",
      description: "All tracked Pokémon TCG cards from a live card shop inventory: name, set, number, condition, printing, TCGplayer-based market price, 7-day change",
      ...service,
      extensions: { ...declareDiscoveryExtension({
        input: {}, inputSchema: { properties: {}, required: [] },
        output: { example: { count: 182, cards: [exampleCard] } },
      }) },
    },
    "GET /v1/card/:id": {
      accepts: accept(PRICES.card), mimeType: "application/json",
      description: "One Pokémon TCG card by id (ids come from /v1/cards, /v1/search or the free /v1/sample) with condition-aware market price",
      ...service,
      extensions: { ...declareDiscoveryExtension({
        input: {}, inputSchema: { properties: {}, required: [] },
        pathParams: { id: "122" },
        pathParamsSchema: { properties: { id: { type: "string", description: "Card id from /v1/cards or /v1/search" } }, required: ["id"] },
        output: { example: exampleCard },
      }) },
    },
    "GET /v1/search": {
      accepts: accept(PRICES.search), mimeType: "application/json",
      description: "Search Pokémon TCG cards by name or set; returns condition-aware market prices",
      ...service,
      extensions: { ...declareDiscoveryExtension({
        input: { q: "pichu" },
        inputSchema: { properties: { q: { type: "string", description: "Card name or set text" } }, required: ["q"] },
        output: { example: { q: "pichu", count: 1, cards: [exampleCard] } },
      }) },
    },
    "GET /v1/movers": {
      accepts: accept(PRICES.movers), mimeType: "application/json",
      description: "Biggest 7-day price movers (up and down) across tracked Pokémon TCG cards",
      ...service,
      extensions: { ...declareDiscoveryExtension({
        input: { n: 10 },
        inputSchema: { properties: { n: { type: "number", description: "How many movers each way (max 50)" } }, required: [] },
        output: { example: { up: [exampleCard], down: [{ ...exampleCard, chg7: -4.1 }] } },
      }) },
    },
  };

  return paymentMiddleware(routes, server, { appName: "Foil Ledger API", testnet: network === "eip155:84532" })(c, next);
});

// ---------- paid handlers ----------
app.get("/v1/cards", async (c) => {
  const cards = await loadCards(c.env);
  return c.json({ count: cards.length, cards: cards.map(pub) });
});

app.get("/v1/card/:id", async (c) => {
  const cards = await loadCards(c.env);
  const card = cards.find((x) => x.id === c.req.param("id"));
  return card ? c.json(pub(card)) : c.json({ error: "not found" }, 404);
});

app.get("/v1/search", async (c) => {
  const q = (c.req.query("q") ?? "").toLowerCase().trim();
  if (!q) return c.json({ error: "q required" }, 400);
  const cards = await loadCards(c.env);
  const hits = cards.filter((x) => `${x.name} ${x.set} ${x.number}`.toLowerCase().includes(q)).slice(0, 100);
  return c.json({ q, count: hits.length, cards: hits.map(pub) });
});

app.get("/v1/movers", async (c) => {
  const n = Math.min(50, Math.max(1, Number(c.req.query("n") ?? 10)));
  const cards = (await loadCards(c.env)).filter((x) => typeof x.chg7 === "number" && x.price >= 1);
  const sorted = [...cards].sort((a, b) => (b.chg7 as number) - (a.chg7 as number));
  return c.json({ up: sorted.slice(0, n).map(pub), down: sorted.slice(-n).reverse().map(pub) });
});

export default app;
