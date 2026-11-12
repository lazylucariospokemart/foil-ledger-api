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
import { discoveryApp, type RouteInfo } from "./discovery";
import { scanCard, imageFromInput, shopMatches, exampleScan, SCAN_PRICE, type ScanResult } from "./scan";

type Env = {
  LEDGER: KVNamespace;          // referral + call ledger
  AI: Ai;                       // Workers AI (card scan vision model)
  SCAN_MODEL?: string;          // optional override of the vision model id
  PAY_TO: string;               // Lazy's USDC receiving address (public address only)
  NETWORK?: string;             // "eip155:84532" (Base Sepolia, default) or "eip155:8453" (Base mainnet)
  FACILITATOR_URL?: string;     // testnet default https://x402.org/facilitator ; mainnet https://api.cdp.coinbase.com/platform/v2/x402
  CDP_API_KEY_ID?: string;      // only needed on mainnet (Coinbase facilitator)
  CDP_API_KEY_SECRET?: string;
  REFERRAL_PCT?: string;        // e.g. "10"
  OWN_WALLETS?: string;         // comma-separated buyer wallets owned by Lazy (test/robot budget); excluded from income
  DATA_URL?: string;
  PRICES_URL?: string;
  SALES_URL?: string;
};

const DEFAULT_DATA_URL   = "https://raw.githubusercontent.com/lazylucariospokemart/lazy-lucario-vault/main/data.json";
const DEFAULT_PRICES_URL = "https://raw.githubusercontent.com/lazylucariospokemart/lazy-lucario-vault/main/prices/latest.json";
const DEFAULT_SALES_URL  = "https://raw.githubusercontent.com/lazylucariospokemart/lazy-lucario-vault/main/sales.json";

// ---------- prices (what we sell) ----------
const PRICES = {
  cards:  "$0.005",   // full list
  card:   "$0.002",   // one card
  search: "$0.005",   // name search
  movers: "$0.01",    // top 7-day movers
  sold:   "$0.005",   // realized sales (what the shop actually got)
  comp:   "$0.01",    // one card: market price next to realized sales
  scan:   SCAN_PRICE, // photo of any Pokémon card -> identified card + TCGplayer prices (only charged on a match)
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

  // the live shelf only: sold cards move to the realized-sales feed (sales.json → /v1/sold)
  const cards: Card[] = Object.entries(data.cards).filter(([, c]) => !c.sold).map(([id, c]) => {
    // prefer the daily price file when it has this card+condition
    const p = c.tcgId && prices[`${c.tcgId}|${c.cond}`];
    return {
      id, name: c.name, set: c.set, number: c.number, cond: c.cond, printing: c.printing,
      rarity: c.rarity, language: c.language,
      price: Number(p?.price ?? c.price ?? 0),
      chg7: p?.chg7 ?? c.chg7 ?? null,
      priceAt: p?.at ?? c.priceAt,
      kind: c.kind ?? "single",
      // deliberately NOT exposed: ask (Lazy's asking price), notes, qty, photo, cert
    };
  });
  cache = { at: Date.now(), cards };
  return cards;
}

const pub = (c: Card) => c; // already stripped above

// ---------- realized sales (ground truth: what this shop actually got) ----------
type Sale = {
  id: string; kind: string; name: string; set?: string; number?: string; cond?: string; printing?: string;
  rarity?: string; language?: string; grade?: string; grader?: string; sealedType?: string; tcgId?: string | null;
  soldPrice: number | null; priceBasis: "desk" | "ask" | "market"; soldAt: string | null; channel: string;
  market: { price: number | null; chg7: number | null; at?: string }; loggedAt: string; backfilled?: boolean;
};
let salesCache: { at: number; sales: Sale[]; updatedAt?: string } | null = null;

async function loadSales(env: Env): Promise<{ sales: Sale[]; updatedAt?: string }> {
  if (salesCache && Date.now() - salesCache.at < TTL_MS) return salesCache;
  const res = await fetch(env.SALES_URL ?? DEFAULT_SALES_URL, { cf: { cacheTtl: 900 } } as RequestInit);
  const doc = res.ok ? ((await res.json()) as { sales?: Sale[]; updatedAt?: string }) : {};
  const sales = (doc.sales ?? []).filter((x) => typeof x.soldPrice === "number");
  salesCache = { at: Date.now(), sales, updatedAt: doc.updatedAt };
  return salesCache;
}
const saleText = (x: Sale) => `${x.name} ${x.set ?? ""} ${x.number ?? ""} ${x.tcgId ?? ""}`.toLowerCase();
const matchSales = (sales: Sale[], q: string) => sales.filter((x) => saleText(x).includes(q));
const SALES_NOTE = "Realized sales from one working card shop (Lazy Lucario Vault): the price the seller actually got, next to the TCGplayer-based market price at the time. priceBasis: desk = entered by the seller, ask = the listed asking price, market = no asking price on file so market value is used. soldAt is null for sales logged before the log existed (backfilled: true). Small dataset, verified provenance; not a market average.";

// ---------- app ----------
const app = new Hono<{ Bindings: Env }>();
app.use("*", cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE", "Mcp-Session-Id"], allowHeaders: ["Content-Type", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "PAYMENT-SIGNATURE", "X-PAYMENT"] }));

// MCP: the same data as paid tools for agents (Claude, Cursor, ...). Stateless streamable-HTTP.
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env));

// Free discovery files for indexers: /.well-known/x402, agent.json, openapi.json, llms.txt, ...
const PAID_ROUTES: RouteInfo[] = [
  { method: "GET", path: "/v1/cards",     price: PRICES.cards,  desc: "All tracked cards with current market price and 7-day change" },
  { method: "GET", path: "/v1/card/:id",  price: PRICES.card,   desc: "One card by id (ids from /v1/cards, /v1/search or the free /v1/sample)", pathParam: "id" },
  { method: "GET", path: "/v1/search",    price: PRICES.search, desc: "Search by card name / set", query: { q: "Card name or set text" } },
  { method: "GET", path: "/v1/movers",    price: PRICES.movers, desc: "Biggest 7-day movers, up and down", query: { n: "How many each way (max 50)" } },
  { method: "GET", path: "/v1/sold",      price: PRICES.sold,   desc: "Realized sales: what this shop actually got per card, with the market price at the time", query: { q: "Filter by name/set/number", n: "Max results (max 500)" } },
  { method: "GET", path: "/v1/scan",      price: PRICES.scan,   desc: "Scan any Pokémon card from a photo: identifies the exact card (name, number, set, printing) and returns TCGplayer prices plus a condition estimate. Also POST /v1/scan with a JSON {image} (base64/data URL) or a raw image body. Charged only when a card is matched", query: { url: "Public URL of a card photo (jpg/png/webp, max 4 MB)" } },
  { method: "GET", path: "/v1/comp",      price: PRICES.comp,   desc: "Comp one card: live market price for matching cards next to this shop's realized sales", query: { q: "Card name, set or number text" } },
];
const FREE_ROUTES: RouteInfo[] = [
  { method: "GET", path: "/",             price: "free", desc: "Landing: endpoints, prices, MCP, referral terms" },
  { method: "GET", path: "/v1/sample",    price: "free", desc: "Three real cards and one real sale so you can see the response shapes" },
  { method: "GET", path: "/v1/scan/sample", price: "free", desc: "One real card scan of a fixed public image, so you can see the /v1/scan response before paying" },
  { method: "GET", path: "/v1/health",    price: "free", desc: "Freshness + card count" },
  { method: "GET", path: "/v1/stats",     price: "free", desc: "Calls and USDC earned today / last 7 days (no addresses)" },
  { method: "GET", path: "/v1/referrals/:address", price: "free", desc: "Referral earnings for a wallet", pathParam: "address" },
];
app.route("/", discoveryApp(PAID_ROUTES, FREE_ROUTES, { ...MCP_PRICES, get_sample: "free", health: "free" }));

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
    "GET /v1/sold?q=&n=":   { price: PRICES.sold,   desc: "Realized sales: what this shop actually got per card, with the market price at the time (q filters by name/set/number)" },
    "GET /v1/comp?q=":      { price: PRICES.comp,   desc: "Comp one card: live market price for matching cards next to this shop's realized sales of them" },
    "GET /v1/scan?url=":    { price: PRICES.scan,   desc: "Photo of ANY Pokémon card -> exact card match + TCGplayer prices per printing + condition estimate (+ this shop's listings/sales of it). Charged only on a match" },
    "POST /v1/scan":        { price: PRICES.scan,   desc: "Same, uploading the photo: JSON {\"image\": \"<base64 or data URL>\"} or {\"url\"}, or a raw image/* body (max 4 MB)" },
    "GET /v1/scan/sample":  { price: "free",        desc: "One real scan of a fixed public card image (see the scan response shape)" },
    "GET /v1/sample":       { price: "free",        desc: "Three real cards and one real sale so you can see the response shapes" },
    "GET /v1/health":       { price: "free",        desc: "Freshness + card count" },
    "GET /v1/stats":        { price: "free",        desc: "Calls and USDC earned today / last 7 days (no addresses)" },
    "GET /v1/referrals/:address": { price: "free",  desc: "Referral earnings for a wallet" },
  },
  mcp: { url: new URL("/mcp", c.req.url).toString(), transport: "streamable-http", tools: { ...MCP_PRICES, get_sample: "free", health: "free" }, note: "Same data as the REST routes, as MCP tools with x402 payment per call" },
  groundTruth: SALES_NOTE,
  referrals: `Add ?ref=0xYourWallet to any paid call. You earn ${c.env.REFERRAL_PCT ?? "10"}% of every call you bring, paid out weekly in USDC. One level, sales only.`,
  docs: "https://docs.x402.org",
  discovery: { openapi: new URL("/openapi.json", c.req.url).toString(), llms: new URL("/llms.txt", c.req.url).toString(), x402: new URL("/.well-known/x402", c.req.url).toString(), agent: new URL("/.well-known/agent.json", c.req.url).toString() },
  owner: "Lazy Lucario — lazylucariospokemart.github.io/lazy-lucario-vault",
}));

// Free: one real scan of a fixed public card image so buyers (and Lazy) can see it work. Cached a day.
const SAMPLE_SCAN_URL = "https://assets.tcgdex.net/en/ex/ex9/21/high.png";
app.get("/v1/scan/sample", async (c) => {
  const key = `scan-sample:${new Date().toISOString().slice(0, 10)}`;
  const hit = await c.env.LEDGER.get(key);
  if (hit && !c.req.query("fresh")) return c.json({ ...JSON.parse(hit), cached: true });
  const img = await imageFromInput({ url: SAMPLE_SCAN_URL });
  if ("ok" in img) return c.json({ error: img.error }, img.status);
  const res = await scanCard(c.env, img.dataUrl);
  if (!res.ok) return c.json({ sample: SAMPLE_SCAN_URL, error: res.error, read: res.read }, 502);
  const out = { note: `Free sample scan of ${SAMPLE_SCAN_URL}. Scan your own photo with GET /v1/scan?url= or POST /v1/scan (${PRICES.scan}, charged only on a match).`, ...(await withShop(c.env, res)) };
  await c.env.LEDGER.put(key, JSON.stringify(out), { expirationTtl: 60 * 60 * 26 });
  return c.json(out);
});

app.get("/v1/health", async (c) => {
  const cards = await loadCards(c.env);
  const newest = cards.map((x) => x.priceAt ?? "").sort().pop();
  const { sales, updatedAt } = await loadSales(c.env);
  return c.json({ ok: true, cards: cards.length, pricesAsOf: newest, sales: sales.length, salesAsOf: updatedAt, network: c.env.NETWORK ?? "eip155:84532" });
});

// Free sample: 3 real cards so buyers can see the shape before paying
app.get("/v1/sample", async (c) => {
  const cards = (await loadCards(c.env)).filter((x) => typeof x.chg7 === "number" && x.price >= 1);
  const sorted = [...cards].sort((a, b) => (b.chg7 as number) - (a.chg7 as number));
  const sample = [sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]].filter(Boolean);
  const { sales } = await loadSales(c.env);
  const sale = [...sales].sort((a, b) => (b.soldAt ?? "").localeCompare(a.soldAt ?? ""))[0] ?? null;
  return c.json({ note: "Free sample. Full data is pay-per-call; see / for prices.", count: cards.length, cards: sample.map(pub), salesCount: sales.length, sale });
});

// Free stats for the factory Foreman: calls + USDC earned, no addresses
app.get("/v1/stats", async (c) => {
  const chi = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  // ?days=N (1..60) also returns a per-day list, so the factory's goal meter can total a whole month
  const want = Math.min(60, Math.max(7, Number(c.req.query("days") ?? 7) || 7));
  const days: string[] = [];
  for (let i = 0; i < want; i++) { const d = new Date(chi); d.setDate(chi.getDate() - i); days.push(day(d)); }
  const rows = await Promise.all(days.map(async (k) => JSON.parse((await c.env.LEDGER.get(`day:${k}`)) ?? "null")));
  const today = rows[0] ?? { calls: 0, usd: 0, byRoute: {} };
  const last7 = rows.slice(0, 7).reduce((a, r) => r ? { calls: a.calls + r.calls, usd: +(a.usd + r.usd).toFixed(6) } : a, { calls: 0, usd: 0 });
  const byDay = want > 7 ? days.map((k, i) => ({ date: k, calls: rows[i]?.calls ?? 0, usd: rows[i]?.usd ?? 0, ownCalls: rows[i]?.ownCalls ?? 0, ownUsd: rows[i]?.ownUsd ?? 0 })).filter((r) => r.calls > 0 || r.ownCalls > 0) : undefined;
  let owed = 0, referrers = 0;
  const list = await c.env.LEDGER.list({ prefix: "ref:" });
  for (const k of list.keys) { const r = JSON.parse((await c.env.LEDGER.get(k.name)) ?? "{}"); referrers++; owed += (r.owedUsd ?? 0) - (r.paidUsd ?? 0); }
  return c.json({ network: c.env.NETWORK ?? "eip155:84532", today: { date: days[0], calls: today.calls, usd: today.usd, byRoute: today.byRoute }, last7, ...(byDay ? { byDay } : {}), referrers, referralOwedUsd: +owed.toFixed(6) });
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

        // daily totals (for the factory dashboard). Lazy's own buyer wallets (OWN_WALLETS) are tallied
        // separately as "own" so test calls and robot canaries never count as income.
        const own = (env.OWN_WALLETS ?? "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
        const payer = String(ctx.result.payer ?? "").toLowerCase();
        const isOwn = !!payer && own.includes(payer);
        const dKey = `day:${day}`;
        const d = JSON.parse((await env.LEDGER.get(dKey)) ?? '{"calls":0,"usd":0,"byRoute":{}}');
        const route = new URL(url).pathname;
        if (isOwn) { d.ownCalls = (d.ownCalls ?? 0) + 1; d.ownUsd = +((d.ownUsd ?? 0) + usd).toFixed(6); }
        else { d.calls++; d.usd = +(d.usd + usd).toFixed(6); d.byRoute[route] = (d.byRoute[route] ?? 0) + 1; }
        await env.LEDGER.put(dKey, JSON.stringify(d), { expirationTtl: 60 * 60 * 24 * 400 });
        if (isOwn) return;

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
  const exampleSale = {
    id: "54", kind: "single", name: "Zangoose", set: "EX Emerald", number: "21/106", cond: "NM", printing: "Reverse Holofoil",
    rarity: "Rare", language: "English", tcgId: "90703", soldPrice: 47.75, priceBasis: "market", soldAt: "2026-10-24T06:30:54Z",
    channel: "vault", market: { price: 47.75, chg7: 0, at: "2026-11-01T20:55:08Z" }, loggedAt: "2026-11-05T21:34:24Z",
  };
  const scanDesc = "Scan any Pokémon TCG card from a photo: a vision model reads it, it is matched to the exact card (name, collector number, set, printing, language), and you get TCGplayer market/low/mid/high prices per printing plus a condition estimate from the photo, and the shop's own listings and realized sales of that card. Charged only when a card is matched";
  const scanOut = { example: exampleScan };
  const routes: RoutesConfig = {
    "GET /v1/scan": {
      accepts: accept(PRICES.scan), mimeType: "application/json", description: scanDesc, ...service,
      extensions: { ...declareDiscoveryExtension({
        input: { url: "https://assets.tcgdex.net/en/ex/ex9/21/high.png" },
        inputSchema: { properties: { url: { type: "string", description: "Public URL of a photo of one Pokémon card (jpg/png/webp, max 4 MB)" } }, required: ["url"] },
        output: scanOut,
      }) },
    },
    "POST /v1/scan": {
      accepts: accept(PRICES.scan), mimeType: "application/json", description: scanDesc, ...service,
      extensions: { ...declareDiscoveryExtension({
        bodyType: "json",
        input: { image: "data:image/jpeg;base64,/9j/4AAQ..." },
        inputSchema: { properties: { image: { type: "string", description: "Card photo as base64 or a data URL (max 4 MB)" }, url: { type: "string", description: "Or a public image URL" } }, required: [] },
        output: scanOut,
      }) },
    },
    "GET /v1/sold": {
      accepts: accept(PRICES.sold), mimeType: "application/json",
      description: "Realized Pokémon TCG sales from a live card shop: the price actually received per card (with condition, printing, basis and channel) next to the market price at the time. Ground truth, not an aggregate. Optional q filters by name/set/number, n caps results",
      ...service,
      extensions: { ...declareDiscoveryExtension({
        input: { q: "zangoose", n: 50 },
        inputSchema: { properties: { q: { type: "string", description: "Card name, set or number text (optional)" }, n: { type: "number", description: "Max results (default 200, max 500)" } }, required: [] },
        output: { example: { q: "zangoose", count: 1, asOf: "2026-11-05T21:34:24Z", sales: [exampleSale] } },
      }) },
    },
    "GET /v1/comp": {
      accepts: accept(PRICES.comp), mimeType: "application/json",
      description: "Comp one Pokémon TCG card: matching cards' live condition-aware market prices next to the same shop's realized sales of that card (what it actually sold for and when)",
      ...service,
      extensions: { ...declareDiscoveryExtension({
        input: { q: "zangoose" },
        inputSchema: { properties: { q: { type: "string", description: "Card name, set or number text" } }, required: ["q"] },
        output: { example: { q: "zangoose", listed: [exampleCard], sold: [exampleSale], summary: { listedCount: 1, soldCount: 1, lastSold: 47.75, lastSoldAt: "2026-10-24T06:30:54Z", avgSoldVsMarketPct: 0 } } },
      }) },
    },
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

app.get("/v1/sold", async (c) => {
  const q = (c.req.query("q") ?? "").toLowerCase().trim();
  const n = Math.min(500, Math.max(1, Number(c.req.query("n") ?? 200)));
  const { sales, updatedAt } = await loadSales(c.env);
  const hits = (q ? matchSales(sales, q) : sales).slice(-n).reverse();
  return c.json({ q: q || undefined, count: hits.length, total: sales.length, asOf: updatedAt, note: SALES_NOTE, sales: hits });
});

app.get("/v1/comp", async (c) => {
  const q = (c.req.query("q") ?? "").toLowerCase().trim();
  if (!q) return c.json({ error: "q required" }, 400);
  const [cards, { sales, updatedAt }] = await Promise.all([loadCards(c.env), loadSales(c.env)]);
  const listed = cards.filter((x) => `${x.name} ${x.set} ${x.number}`.toLowerCase().includes(q)).slice(0, 50).map(pub);
  const sold = matchSales(sales, q).slice(-50).reverse();
  const dated = sold.filter((x) => x.soldAt);
  const last = dated[0] ?? sold[0];
  const ratios = sold.filter((x) => x.market.price && x.priceBasis !== "market").map((x) => ((x.soldPrice as number) / (x.market.price as number) - 1) * 100);
  const summary = {
    listedCount: listed.length, soldCount: sold.length,
    lastSold: last?.soldPrice ?? null, lastSoldAt: last?.soldAt ?? null, lastSoldCond: last?.cond ?? null,
    avgSoldVsMarketPct: ratios.length ? +(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(1) : null,
  };
  return c.json({ q, asOf: updatedAt, note: SALES_NOTE, listed, sold, summary });
});

// ---------- card scan ----------
async function finishScan(c: any, img: Awaited<ReturnType<typeof imageFromInput>>) {
  if ("ok" in img) return c.json({ error: img.error }, img.status);
  const res = await scanCard(c.env, img.dataUrl);
  if (!res.ok) return c.json({ error: res.error, read: res.read }, res.status); // 4xx/5xx → x402 cancels: no charge
  return c.json(await withShop(c.env, res));
}
async function withShop(env: Env, res: ScanResult) {
  const [cards, { sales }] = await Promise.all([loadCards(env).catch(() => [] as Card[]), loadSales(env).catch(() => ({ sales: [] as Sale[] }))]);
  return { ...res, shop: { listed: shopMatches(cards, res).map(pub), sold: shopMatches(sales, res), note: "This shop's own listings and realized sales of the matched card, if any." } };
}
app.get("/v1/scan", async (c) => {
  const url = c.req.query("url");
  return finishScan(c, await imageFromInput({ url }));
});
app.post("/v1/scan", async (c) => {
  const type = (c.req.header("content-type") ?? "").split(";")[0].trim();
  if (type.startsWith("image/")) return finishScan(c, await imageFromInput({ bytes: await c.req.arrayBuffer(), type }));
  let body: any = {};
  try { body = await c.req.json(); } catch { return c.json({ error: "send JSON {image} / {url} or a raw image/* body" }, 400); }
  return finishScan(c, await imageFromInput({ base64: body.image ?? body.base64, url: body.url }));
});

export default app;
