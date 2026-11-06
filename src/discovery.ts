/**
 * Discovery endpoints — free, machine-readable descriptions of this API for the
 * crawlers that index x402 services. The Worker's logs showed indexers asking for
 * every one of these paths and getting 404s:
 *
 *   /.well-known/x402          draft-hawkins-x402-dns-discovery (resource-server manifest)
 *   /.well-known/agent.json    Open 402 Directory / Agent Web Protocol manifest
 *   /agent.json, /agents.json  same manifest at the root paths some crawlers try
 *   /openapi.json              OpenAPI 3.1 with x402 pricing on every paid route
 *   /llms.txt                  plain-text guide for LLM agents
 *   /.well-known/ai-catalog.json  Agentic Resource Discovery catalog (REST + MCP)
 *   /robots.txt, /sitemap.xml  so generic crawlers stop 404ing too
 *
 * Nothing here is paid and nothing here exposes anything the landing page doesn't.
 */
import { Hono } from "hono";

export type DiscoveryEnv = {
  PAY_TO: string;
  NETWORK?: string;
  REFERRAL_PCT?: string;
};

export type RouteInfo = { method: "GET"; path: string; price: string; desc: string; query?: Record<string, string>; pathParam?: string };

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const UPDATED = "2026-11-06T07:40:00Z";

const NAME = "Foil Ledger API";
const DESC = "Condition-aware Pokémon TCG market prices (TCGplayer-based, refreshed daily) plus realized sales from a working card shop. Pay per call with USDC on Base via x402; also available as paid MCP tools at /mcp.";
const REPO = "https://github.com/lazylucariospokemart/foil-ledger-api";

function netName(n: string) { return n === "eip155:8453" ? "base" : n === "eip155:84532" ? "base-sepolia" : n; }

export function discoveryApp(paid: RouteInfo[], free: RouteInfo[], mcpTools: Record<string, string>) {
  const app = new Hono<{ Bindings: DiscoveryEnv }>();
  const all = [...paid, ...free];
  const cacheHdr = { "Cache-Control": "public, max-age=3600" };

  const origin = (url: string) => new URL(url).origin;
  const host = (url: string) => new URL(url).host;

  // ---- draft-hawkins-x402-dns-discovery: /.well-known/x402 ----
  app.get("/.well-known/x402", (c) => {
    const o = origin(c.req.url);
    const network = c.env.NETWORK ?? "eip155:8453";
    return c.json({
      x402Version: 2,
      kind: "resource-server",
      name: NAME,
      description: DESC,
      resources: paid.map((r) => ({
        url: `${o}${r.path}`, method: r.method, description: r.desc,
        accepts: [{ scheme: "exact", network, asset: USDC_BASE, symbol: "USDC", price: r.price, payTo: c.env.PAY_TO }],
      })),
      mcp: { url: `${o}/mcp`, transport: "streamable-http" },
      attestation: { type: "none" },
      docs: REPO,
      contact: "https://lazylucariospokemart.github.io/lazy-lucario-vault/",
      updated: UPDATED,
    }, 200, cacheHdr);
  });

  // ---- Open 402 Directory / AWP: agent.json ----
  const agentJson = (c: any) => {
    const network = c.env.NETWORK ?? "eip155:8453";
    const pct = Number(c.env.REFERRAL_PCT ?? 10);
    const usd = (p: string) => Number(p.replace("$", ""));
    // Referral split in the spec's own terms: a per-call "bounty" (cpa, USDC) = pct% of the route price,
    // paid to whoever routes the call (append ?ref=0xWallet). Free routes carry no bounty.
    const bounty = (p: string) => ({ type: "cpa", rate: +(usd(p) * pct / 100).toFixed(6), currency: "USDC" });
    const cheapest = Math.min(...paid.map((r) => usd(r.price)));
    return c.json({
      version: "1.3",
      origin: host(c.req.url),
      display_name: NAME,
      description: DESC,
      payout_address: c.env.PAY_TO,
      payments: { x402: { networks: [{ network: netName(network), asset: "USDC", contract: USDC_BASE }] } },
      intents: all.map((r) => ({
        name: r.path.replace(/^\/v1\//, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root",
        description: r.desc,
        endpoint: r.path,
        method: r.method,
        parameters: Object.fromEntries([
          ...(r.pathParam ? [[r.pathParam, { type: "string", required: true, description: `Path parameter ${r.pathParam}` }]] : []),
          ...Object.entries(r.query ?? {}).map(([k, d]) => [k, { type: "string", required: false, description: d }]),
        ]),
        price: r.price === "free" ? { amount: 0, currency: "USDC" } : { amount: usd(r.price), currency: "USDC" },
        ...(r.price === "free" ? {} : { bounty: bounty(r.price) }),
      })),
      bounty: { type: "cpa", rate: +(cheapest * pct / 100).toFixed(6), currency: "USDC" },
      extensions: {
        foilledger: {
          referrals: { pct, how: "append ?ref=0xYourWallet to any paid call; the bounty is pct% of that call's price, settled weekly in USDC; free tally at /v1/referrals/:address" },
          protocols: { x402: `${origin(c.req.url)}/.well-known/x402`, openapi: `${origin(c.req.url)}/openapi.json`, mcp: `${origin(c.req.url)}/mcp`, llms: `${origin(c.req.url)}/llms.txt` },
          caip2: network,
          docs: REPO,
          updated: UPDATED,
        },
      },
    }, 200, cacheHdr);
  };
  app.get("/.well-known/agent.json", agentJson);
  app.get("/agent.json", agentJson);
  app.get("/agents.json", agentJson);

  // ---- OpenAPI 3.1 ----
  app.get("/openapi.json", (c) => {
    const o = origin(c.req.url);
    const network = c.env.NETWORK ?? "eip155:8453";
    const paths: Record<string, any> = {};
    for (const r of all) {
      const p = r.pathParam ? r.path.replace(`:${r.pathParam}`, `{${r.pathParam}}`) : r.path;
      const parameters: any[] = [];
      if (r.pathParam) parameters.push({ name: r.pathParam, in: "path", required: true, schema: { type: "string" } });
      for (const [k, d] of Object.entries(r.query ?? {})) parameters.push({ name: k, in: "query", required: false, schema: { type: "string" }, description: d });
      const responses: Record<string, any> = { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } };
      if (r.price !== "free") responses["402"] = { description: "Payment Required (x402). Retry with a PAYMENT-SIGNATURE header; see https://docs.x402.org" };
      paths[p] = { get: { summary: r.desc, operationId: (r.path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root"), parameters, responses,
        "x-x402": r.price === "free" ? { paid: false } : { paid: true, price: r.price, asset: "USDC", network, scheme: "exact", payTo: c.env.PAY_TO } } };
    }
    return c.json({
      openapi: "3.1.0",
      info: { title: NAME, version: "1.1.0", description: DESC, contact: { url: REPO }, license: { name: "MIT" } },
      servers: [{ url: o }],
      "x-x402": { network, asset: USDC_BASE, symbol: "USDC", payTo: c.env.PAY_TO, manifest: `${o}/.well-known/x402`, mcp: `${o}/mcp`, referralPct: Number(c.env.REFERRAL_PCT ?? 10) },
      paths,
    }, 200, cacheHdr);
  });

  // ---- llms.txt ----
  app.get("/llms.txt", (c) => {
    const o = origin(c.req.url);
    const lines = [
      `# ${NAME}`, "", `> ${DESC}`, "",
      "No API key, no account. Paid routes answer HTTP 402 with x402 payment requirements; any x402 client (e.g. @x402/fetch) pays USDC on Base and retries automatically. Prices are per call.",
      "", "## Free", ...free.map((r) => `- ${o}${r.path} — ${r.desc}`),
      "", "## Paid (USDC per call)", ...paid.map((r) => `- ${o}${r.path} — ${r.price} — ${r.desc}`),
      "", "## MCP", `- ${o}/mcp — streamable HTTP; tools: ${Object.entries(mcpTools).map(([k, v]) => `${k} (${v})`).join(", ")}`,
      "", "## Referrals", `- Append ?ref=0xYourWallet to any paid call to earn ${c.env.REFERRAL_PCT ?? 10}% of it. Free tally: ${o}/v1/referrals/0xYourWallet`,
      "", "## Machine-readable", `- ${o}/openapi.json`, `- ${o}/.well-known/x402`, `- ${o}/.well-known/agent.json`, `- ${o}/.well-known/ai-catalog.json`,
      "", "## Docs", `- ${REPO}`, "",
    ];
    return c.text(lines.join("\n"), 200, cacheHdr);
  });

  // ---- Agentic Resource Discovery catalog ----
  app.get("/.well-known/ai-catalog.json", (c) => {
    const o = origin(c.req.url); const h = host(c.req.url);
    return c.json({
      specVersion: "1.0",
      host: { displayName: NAME, identifier: h },
      entries: [
        { identifier: `urn:ai:${h}:mcp`, displayName: `${NAME} (MCP)`, type: "application/mcp-server+json", url: `${o}/mcp`, description: "Paid MCP tools (x402 per call) for Pokémon TCG prices and realized sales" },
        { identifier: `urn:ai:${h}:openapi`, displayName: `${NAME} (REST)`, type: "application/vnd.oai.openapi+json", url: `${o}/openapi.json`, description: DESC },
        { identifier: `urn:ai:${h}:llms`, displayName: "llms.txt", type: "text/markdown", url: `${o}/llms.txt`, description: "Plain-text guide for agents" },
      ],
      updated: UPDATED,
    }, 200, cacheHdr);
  });

  app.get("/robots.txt", (c) => c.text(`User-agent: *\nAllow: /\nSitemap: ${origin(c.req.url)}/sitemap.xml\n`, 200, cacheHdr));
  app.get("/sitemap.xml", (c) => {
    const o = origin(c.req.url);
    const urls = ["/", "/llms.txt", "/openapi.json", "/.well-known/x402", "/.well-known/agent.json", "/v1/sample", "/v1/health"];
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${o}${u}</loc></url>`).join("\n")}\n</urlset>\n`, 200, { "Content-Type": "application/xml", ...cacheHdr });
  });

  return app;
}
