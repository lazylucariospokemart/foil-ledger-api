/**
 * Foil Ledger MCP — the Foil Ledger price API exposed as paid MCP tools (x402, USDC on Base).
 *
 * Any MCP-capable agent (Claude, Cursor, OpenClaw, ...) adds this server's URL and gets
 * get_card_price / search_cards / get_movers / get_all_cards as tools, paying per call.
 * Free tools: get_sample, health.
 *
 * Shares the LEDGER KV namespace with foil-ledger-api so /v1/stats there counts MCP calls too.
 * Data comes straight from the vault repo (same source as the API); nothing here calls the paid API.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";

export type McpEnv = {
  LEDGER: KVNamespace;
  PAY_TO: string;
  NETWORK?: string;
  FACILITATOR_URL?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  DATA_URL?: string;
  PRICES_URL?: string;
  MCP_URL?: string;
};

const DEFAULT_DATA_URL   = "https://raw.githubusercontent.com/lazylucariospokemart/lazy-lucario-vault/main/data.json";
const DEFAULT_PRICES_URL = "https://raw.githubusercontent.com/lazylucariospokemart/lazy-lucario-vault/main/prices/latest.json";
const DEFAULT_MCP_URL    = "https://foil-ledger-api.lazylucariospokemart28.workers.dev/mcp";

export const MCP_PRICES = { get_all_cards: "$0.005", get_card_price: "$0.002", search_cards: "$0.005", get_movers: "$0.01" };

type Card = {
  id: string; name: string; set: string; number: string; cond: string; printing?: string;
  rarity?: string; language?: string; price: number; chg7: number | null; priceAt?: string; kind?: string;
};

let cache: { at: number; cards: Card[] } | null = null;
const TTL_MS = 60 * 60 * 1000;

async function loadCards(env: McpEnv): Promise<Card[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.cards;
  const [dataRes, pricesRes] = await Promise.all([
    fetch(env.DATA_URL ?? DEFAULT_DATA_URL, { cf: { cacheTtl: 900 } } as RequestInit),
    fetch(env.PRICES_URL ?? DEFAULT_PRICES_URL, { cf: { cacheTtl: 900 } } as RequestInit),
  ]);
  if (!dataRes.ok) throw new Error(`data.json ${dataRes.status}`);
  const data = (await dataRes.json()) as { cards: Record<string, any> };
  const prices = pricesRes.ok ? ((await pricesRes.json()) as Record<string, any>) : {};
  const cards: Card[] = Object.entries(data.cards).map(([id, c]) => {
    const p = c.tcgId && prices[`${c.tcgId}|${c.cond}`];
    return {
      id, name: c.name, set: c.set, number: c.number, cond: c.cond, printing: c.printing,
      rarity: c.rarity, language: c.language,
      price: Number(p?.price ?? c.price ?? 0),
      chg7: p?.chg7 ?? c.chg7 ?? null,
      priceAt: p?.at ?? c.priceAt,
      kind: c.kind ?? "single",
    };
  });
  cache = { at: Date.now(), cards };
  return cards;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

const exampleCard = {
  id: "122", name: "Pichu - 082/128", set: "Base Expansion Pack", number: "082/128", cond: "NM",
  printing: "1st Edition - Japanese", rarity: "Rare", language: "Japanese", price: 90, chg7: 33.33,
  priceAt: "2026-11-03T14:35:10Z", kind: "single",
};

// Daily call ledger, same keys the API's /v1/stats reads
async function logCall(env: McpEnv, tool: string, atomic: string | undefined) {
  try {
    const usd = Number(BigInt(atomic ?? "0")) / 1e6;
    const day = new Date().toISOString().slice(0, 10);
    const key = `day:${day}`;
    const d = JSON.parse((await env.LEDGER.get(key)) ?? '{"calls":0,"usd":0,"byRoute":{}}');
    const route = `mcp:${tool}`;
    d.calls++; d.usd = +(d.usd + usd).toFixed(6); d.byRoute[route] = (d.byRoute[route] ?? 0) + 1;
    await env.LEDGER.put(key, JSON.stringify(d), { expirationTtl: 60 * 60 * 24 * 400 });
  } catch (e) { console.error("ledger", e); }
}

export async function buildServer(env: McpEnv): Promise<McpServer> {
  const network = (env.NETWORK ?? "eip155:84532") as `${string}:${string}`;
  const facilitator = env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET
    ? new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET))
    : new HTTPFacilitatorClient({ url: env.FACILITATOR_URL ?? "https://x402.org/facilitator" });
  const rs = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
  await rs.initialize();

  const service = {
    serviceName: "Foil Ledger API",
    tags: ["pokemon", "tcg", "prices", "collectibles", "mcp"],
    iconUrl: "https://lazylucariospokemart.github.io/lazy-lucario-vault/favicon.svg",
    mimeType: "application/json",
  };
  const mcpUrl = env.MCP_URL ?? DEFAULT_MCP_URL;

  // One wrapper per tool so each gets its own price + Bazaar entry
  const paidTool = async (tool: keyof typeof MCP_PRICES, description: string, inputSchema: Record<string, unknown>, example: Record<string, unknown>, outputExample: unknown) => {
    const accepts = await rs.buildPaymentRequirements({ scheme: "exact", network, payTo: env.PAY_TO, price: MCP_PRICES[tool] });
    return createPaymentWrapper(rs, {
      accepts,
      resource: { url: `${mcpUrl}#${tool}`, description, ...service },
      extensions: declareDiscoveryExtension({ toolName: tool, description, transport: "streamable-http", inputSchema, example, output: { example: outputExample } }),
      hooks: { onAfterSettlement: async ({ toolName, paymentRequirements }) => logCall(env, toolName, (paymentRequirements as any)?.amount) },
    });
  };

  const server = new McpServer({ name: "foil-ledger", version: "1.0.0" });

  // ---- free ----
  server.tool("health", "Free. Card count, price freshness, network.", {}, async () => {
    const cards = await loadCards(env);
    const newest = cards.map((x) => x.priceAt ?? "").sort().pop();
    return text({ ok: true, cards: cards.length, pricesAsOf: newest, network, prices: MCP_PRICES });
  });
  server.tool("get_sample", "Free. Three real cards so you can see the response shape before paying.", {}, async () => {
    const cards = (await loadCards(env)).filter((x) => typeof x.chg7 === "number" && x.price >= 1);
    const s = [...cards].sort((a, b) => (b.chg7 as number) - (a.chg7 as number));
    return text({ note: "Free sample. Other tools are pay-per-call via x402 (USDC on Base).", count: cards.length, cards: [s[0], s[Math.floor(s.length / 2)], s[s.length - 1]].filter(Boolean) });
  });

  // ---- paid ----
  const paidCard = await paidTool("get_card_price",
    `One Pokémon TCG card by id with condition-aware TCGplayer-based market price and 7-day change. Costs ${MCP_PRICES.get_card_price} USDC.`,
    { properties: { id: { type: "string", description: "Card id from search_cards, get_all_cards or get_sample" } }, required: ["id"] },
    { id: "122" }, exampleCard);
  server.tool("get_card_price", `One card by id. Costs ${MCP_PRICES.get_card_price}.`, { id: z.string() },
    paidCard(async ({ id }) => {
      const card = (await loadCards(env)).find((x) => x.id === id);
      return card ? text(card) : { ...text({ error: "not found", id }), isError: true };
    }));

  const paidSearch = await paidTool("search_cards",
    `Search a live Pokémon card shop's tracked cards by name or set; returns condition-aware market prices. Costs ${MCP_PRICES.search_cards} USDC.`,
    { properties: { q: { type: "string", description: "Card name or set text" } }, required: ["q"] },
    { q: "pichu" }, { q: "pichu", count: 1, cards: [exampleCard] });
  server.tool("search_cards", `Search by name/set. Costs ${MCP_PRICES.search_cards}.`, { q: z.string() },
    paidSearch(async ({ q }) => {
      const needle = q.toLowerCase().trim();
      const hits = (await loadCards(env)).filter((x) => `${x.name} ${x.set} ${x.number}`.toLowerCase().includes(needle)).slice(0, 100);
      return text({ q, count: hits.length, cards: hits });
    }));

  const paidMovers = await paidTool("get_movers",
    `Biggest 7-day price movers (up and down) across a live card shop's tracked Pokémon TCG cards. Costs ${MCP_PRICES.get_movers} USDC.`,
    { properties: { n: { type: "number", description: "How many movers each way (max 50)" } }, required: [] },
    { n: 10 }, { up: [exampleCard], down: [{ ...exampleCard, chg7: -4.1 }] });
  server.tool("get_movers", `Top 7-day movers. Costs ${MCP_PRICES.get_movers}.`, { n: z.number().optional() },
    paidMovers(async ({ n }) => {
      const k = Math.min(50, Math.max(1, Number(n ?? 10)));
      const cards = (await loadCards(env)).filter((x) => typeof x.chg7 === "number" && x.price >= 1);
      const s = [...cards].sort((a, b) => (b.chg7 as number) - (a.chg7 as number));
      return text({ up: s.slice(0, k), down: s.slice(-k).reverse() });
    }));

  const paidAll = await paidTool("get_all_cards",
    `Every tracked Pokémon TCG card from a live card shop inventory with condition, printing, market price and 7-day change. Costs ${MCP_PRICES.get_all_cards} USDC.`,
    { properties: {}, required: [] }, {}, { count: 182, cards: [exampleCard] });
  server.tool("get_all_cards", `All tracked cards. Costs ${MCP_PRICES.get_all_cards}.`, {},
    paidAll(async () => { const cards = await loadCards(env); return text({ count: cards.length, cards }); }));

  return server;
}


/** Stateless MCP endpoint: fresh server + transport per request (Workers share no process memory). */
export async function handleMcp(req: Request, env: McpEnv): Promise<Response> {
  const server = await buildServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}
