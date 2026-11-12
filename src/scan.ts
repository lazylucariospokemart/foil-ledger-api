/**
 * Card scan — photo in, identified Pokémon card + TCGplayer prices out.
 *
 * 1. Read:   a Workers AI vision model reads the card in the photo (name, collector number,
 *            set, language, foil/reverse/1st-edition, rough condition from what's visible).
 * 2. Match:  TCGdex (free, open-source card database, no key) finds the exact card by name +
 *            collector number, scored against the printed set total and the set name.
 * 3. Price:  TCGdex carries TCGplayer prices per printing (normal / holofoil / reverse / 1st ed).
 *            A condition estimate scales the near-mint market price using typical TCGplayer
 *            condition spreads, clearly labelled as an estimate.
 * 4. Shop:   if Lazy's shelf or realized-sales log has the same card, those come back too.
 *
 * Shared by the REST route (/v1/scan) and the MCP tool (scan_card). Failure → an error object,
 * and the callers answer with a 4xx/isError so x402 cancels settlement: buyers only pay for
 * scans that identify a card.
 */

export type ScanEnv = { AI: Ai; SCAN_MODEL?: string };

export const SCAN_PRICE = "$0.02";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MODELS = ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/google/gemma-3-12b-it"];
const TCGDEX = "https://api.tcgdex.net/v2";

// Typical TCGplayer price spread by condition, relative to Near Mint. Used only for the estimate.
const COND_FACTOR: Record<string, number> = { NM: 1, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.35 };

export type ScanRead = {
  name: string | null; number: string | null; setName: string | null; setCode: string | null;
  language: string | null; foil: "normal" | "holofoil" | "reverse" | null; firstEdition: boolean;
  condition: string | null; conditionNotes: string | null; isPokemonCard: boolean; confidence: number;
};

export type ScanResult = {
  ok: true;
  read: ScanRead;
  match: {
    id: string; name: string; number: string; set: string; setId: string; setTotal: number | null;
    rarity: string | null; image: string | null; language: string; score: number;
  };
  alternatives: { id: string; name: string; number: string; set: string; score: number }[];
  prices: {
    source: "TCGplayer via TCGdex"; currency: "USD"; updated: string | null;
    printing: string | null;
    nearMint: { market: number | null; low: number | null; mid: number | null; high: number | null } | null;
    conditionEstimate: { condition: string; market: number | null; note: string } | null;
    allPrintings: Record<string, { market: number | null; low: number | null }>;
  };
  model: string;
};
export type ScanError = { ok: false; status: 400 | 413 | 415 | 422 | 502; error: string; read?: ScanRead };

// ---------- image input ----------
export async function imageFromInput(input: { url?: string; base64?: string; bytes?: ArrayBuffer; type?: string }):
  Promise<{ dataUrl: string } | ScanError> {
  let bytes: ArrayBuffer; let type = input.type ?? "image/jpeg";
  if (input.bytes) bytes = input.bytes;
  else if (input.base64) {
    const m = input.base64.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) type = m[1];
    const raw = (m ? m[2] : input.base64).replace(/\s+/g, "");
    if (raw.length * 0.75 > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: "image over 4 MB; send a smaller photo" };
    return { dataUrl: `data:${type};base64,${raw}` };
  } else if (input.url) {
    let u: URL;
    try { u = new URL(input.url); } catch { return { ok: false, status: 400, error: "url is not a valid URL" }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, status: 400, error: "url must be http(s)" };
    const res = await fetch(u.toString(), { headers: { Accept: "image/*" } });
    if (!res.ok) return { ok: false, status: 422, error: `could not fetch image (${res.status})` };
    type = (res.headers.get("content-type") ?? type).split(";")[0];
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: "image over 4 MB" };
    bytes = await res.arrayBuffer();
  } else return { ok: false, status: 400, error: "send an image: ?url=, JSON {url} / {image: base64 or data URL}, or a raw image body" };
  if (!type.startsWith("image/")) return { ok: false, status: 415, error: `not an image (${type})` };
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: "image over 4 MB" };
  if (bytes.byteLength < 1000) return { ok: false, status: 422, error: "image is empty or too small" };
  return { dataUrl: `data:${type};base64,${toBase64(bytes)}` };
}

function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- 1. read the card ----------
const PROMPT = `You are reading a photo of a single Pokémon trading card for a price lookup.
Return ONLY a JSON object, no prose, with these keys:
{"isPokemonCard": boolean,
 "name": card name exactly as printed at the top (e.g. "Charizard ex", "Zangoose", "Professor's Research"),
 "number": collector number exactly as printed near the bottom (e.g. "21/106", "082/128", "SWSH050", "TG05/TG30"), or null,
 "setName": the set name if you can tell from the set symbol, copyright line or layout, or null,
 "setCode": any printed set code / regulation text near the number (e.g. "PAL", "SV3", "EM"), or null,
 "language": "en", "ja", "fr", "de", "it", "es", "pt", "ko" or "zh" based on the card text,
 "foil": "holofoil" if the artwork itself is shiny/holographic, "reverse" if the frame/body is shiny but the art is not, "normal" if nothing is shiny, or null if unsure,
 "firstEdition": true only if a "1st Edition" stamp is visible,
 "condition": one of "NM","LP","MP","HP","DMG" judged only from what is visible (whitening, scratches, creases, bends), or null if the photo is too small/blurry,
 "conditionNotes": short note on visible wear, or null,
 "confidence": 0 to 1, how sure you are of name AND number}
If the image is not a Pokémon card, return {"isPokemonCard": false, "confidence": 0}.`;

export async function readCard(env: ScanEnv, dataUrl: string): Promise<{ read: ScanRead; model: string } | ScanError> {
  const models = env.SCAN_MODEL ? [env.SCAN_MODEL, ...MODELS.filter((m) => m !== env.SCAN_MODEL)] : MODELS;
  let lastErr = "";
  for (const model of models) {
    try {
      const out: any = await (env.AI as any).run(model, {
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: dataUrl } }] }],
        max_tokens: 400, temperature: 0.1,
      });
      const txt = typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? out);
      const json = parseJson(txt);
      if (!json) { lastErr = "vision model returned no JSON"; continue; }
      return { read: normalizeRead(json), model };
    } catch (e: any) { lastErr = String(e?.message ?? e); }
  }
  return { ok: false, status: 502, error: `vision model failed: ${lastErr}` };
}

function parseJson(s: string): any | null {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function normalizeRead(j: any): ScanRead {
  const str = (v: any) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null);
  const foil = str(j.foil)?.toLowerCase();
  const cond = str(j.condition)?.toUpperCase();
  return {
    isPokemonCard: j.isPokemonCard !== false,
    name: str(j.name), number: str(j.number), setName: str(j.setName), setCode: str(j.setCode),
    language: str(j.language)?.toLowerCase().slice(0, 2) ?? null,
    foil: foil === "holofoil" || foil === "holo" ? "holofoil" : foil === "reverse" || foil === "reverse holofoil" ? "reverse" : foil === "normal" ? "normal" : null,
    firstEdition: j.firstEdition === true,
    condition: cond && cond in COND_FACTOR ? cond : null,
    conditionNotes: str(j.conditionNotes),
    confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)),
  };
}

// ---------- 2. match against TCGdex ----------
const TCGDEX_LANGS = new Set(["en", "ja", "fr", "de", "it", "es", "pt", "ko", "zh-tw"]);

function numberParts(n: string | null): { local: string | null; total: number | null } {
  if (!n) return { local: null, total: null };
  const clean = n.replace(/\s+/g, "").replace(/^no\.?/i, "");
  const m = clean.match(/^([A-Za-z]*\d+[A-Za-z]?)(?:\/([A-Za-z]*)(\d+))?$/);
  if (!m) return { local: clean, total: null };
  return { local: m[1], total: m[3] ? Number(m[3]) : null };
}

/** "021" → "21", "TG05" → "TG5", "SWSH050" → "SWSH50": comparable collector numbers. */
function normLocal(s: string | null | undefined): string {
  const m = (s ?? "").toUpperCase().match(/^([A-Z]*)0*(\d+)([A-Z]?)$/);
  return m ? `${m[1]}${m[2]}${m[3]}` : (s ?? "").toUpperCase();
}

function localVariants(local: string): string {
  const m = local.match(/^([A-Za-z]*)(\d+)([A-Za-z]?)$/);
  if (!m) return `eq:${local}`;
  const [, pre, digits, suf] = m;
  const n = String(Number(digits));
  const set = new Set([local, `${pre}${n}${suf}`, `${pre}${n.padStart(2, "0")}${suf}`, `${pre}${n.padStart(3, "0")}${suf}`]);
  return `eq:${[...set].join("|")}`;
}

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1);
function overlap(a: string, b: string): number {
  const A = new Set(words(a)), B = words(b);
  if (!A.size || !B.length) return 0;
  return B.filter((w) => A.has(w)).length / Math.max(A.size, B.length);
}

async function tcgdex(path: string): Promise<any | null> {
  const res = await fetch(`${TCGDEX}${path}`, { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
  return res.ok ? res.json() : null;
}

export async function matchCard(read: ScanRead) {
  const lang = read.language && TCGDEX_LANGS.has(read.language) ? read.language : "en";
  const { local, total } = numberParts(read.number);
  const name = (read.name ?? "").replace(/[“”"]/g, "").trim();
  const q = (params: Record<string, string>) => `/${lang}/cards?${new URLSearchParams({ ...params, "pagination:itemsPerPage": "25" })}`;

  // Narrow first (name + number), then loosen: number only (names misread), then name only.
  let briefs: any[] = [];
  if (name && local) briefs = (await tcgdex(q({ name, localId: localVariants(local) }))) ?? [];
  if (!briefs.length && local) {
    const first = words(name)[0];
    if (first) briefs = (await tcgdex(q({ name: first, localId: localVariants(local) }))) ?? [];
  }
  if (!briefs.length && name) {
    // name only: keep the ones whose number matches, if the API's number filter missed them
    const all: any[] = (await tcgdex(`/${lang}/cards?${new URLSearchParams({ name, "pagination:itemsPerPage": "250" })}`)) ?? [];
    const sameNo = local ? all.filter((b) => normLocal(b.localId) === normLocal(local)) : [];
    briefs = sameNo.length ? sameNo : all;
  }
  if (!briefs.length) return null;

  const full = (await Promise.all(briefs.slice(0, 12).map((b) => tcgdex(`/${lang}/cards/${encodeURIComponent(b.id)}`)))).filter(Boolean);
  const scored = full.map((c: any) => {
    let score = 0;
    if (name) score += 3 * overlap(name, c.name ?? "");
    if (local && normLocal(c.localId) === normLocal(local)) score += 2;
    const official = c.set?.cardCount?.official ?? null;
    if (total && official === total) score += 2.5;
    else if (total && c.set?.cardCount?.total === total) score += 1.5;
    if (read.setName && c.set?.name) score += 2 * overlap(read.setName, c.set.name);
    if (read.firstEdition && c.variants?.firstEdition) score += 0.5;
    if (c.pricing?.tcgplayer) score += 0.25; // prefer a match we can price
    return { c, score: +score.toFixed(2) };
  }).sort((a, b) => b.score - a.score);
  return { lang, scored };
}

// ---------- 3. price ----------
const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : null);
function pickPrinting(tp: Record<string, any>, read: ScanRead): string | null {
  const keys = Object.keys(tp).filter((k) => tp[k] && typeof tp[k] === "object");
  const has = (k: string) => keys.includes(k);
  const order: string[] = [];
  if (read.firstEdition) order.push(read.foil === "holofoil" ? "1st-edition-holofoil" : "1st-edition", "1st-edition-holofoil");
  if (read.foil === "reverse") order.push("reverse-holofoil", "reverse");
  if (read.foil === "holofoil") order.push("holofoil", "unlimited-holofoil");
  if (read.foil === "normal") order.push("normal", "unlimited");
  order.push("normal", "holofoil", "unlimited", "unlimited-holofoil", "reverse-holofoil", "reverse");
  return order.find(has) ?? keys[0] ?? null;
}

// ---------- the whole scan ----------
export async function scanCard(env: ScanEnv, dataUrl: string): Promise<ScanResult | ScanError> {
  const r = await readCard(env, dataUrl);
  if ("ok" in r) return r;
  const { read, model } = r;
  if (!read.isPokemonCard) return { ok: false, status: 422, error: "no Pokémon card found in the photo", read };
  if (!read.name && !read.number) return { ok: false, status: 422, error: "could not read the card name or number; try a sharper, closer photo", read };

  const m = await matchCard(read);
  const best = m?.scored[0];
  if (!m || !best || best.score < 2) return { ok: false, status: 422, error: "card read but no confident match in the card database", read };
  const c = best.c;

  const tp = (c.pricing?.tcgplayer ?? {}) as Record<string, any>;
  const printing = pickPrinting(tp, read);
  const p = printing ? tp[printing] : null;
  const nm = p ? { market: num(p.marketPrice), low: num(p.lowPrice), mid: num(p.midPrice), high: num(p.highPrice) } : null;
  const cond = read.condition;
  const allPrintings: Record<string, { market: number | null; low: number | null }> = {};
  for (const [k, v] of Object.entries(tp)) if (v && typeof v === "object") allPrintings[k] = { market: num((v as any).marketPrice), low: num((v as any).lowPrice) };

  return {
    ok: true,
    read,
    match: {
      id: c.id, name: c.name, number: `${c.localId}${c.set?.cardCount?.official ? `/${c.set.cardCount.official}` : ""}`,
      set: c.set?.name ?? "", setId: c.set?.id ?? "", setTotal: c.set?.cardCount?.official ?? null,
      rarity: c.rarity ?? null, image: c.image ? `${c.image}/high.webp` : null, language: m.lang, score: best.score,
    },
    alternatives: m.scored.slice(1, 4).map(({ c: a, score }) => ({ id: a.id, name: a.name, number: a.localId, set: a.set?.name ?? "", score })),
    prices: {
      source: "TCGplayer via TCGdex", currency: "USD", updated: tp.updated ? String(tp.updated) : null, printing,
      nearMint: nm,
      conditionEstimate: cond && nm?.market != null ? {
        condition: cond, market: +(nm.market * COND_FACTOR[cond]).toFixed(2),
        note: "Estimate: condition judged from the photo (not a grade) and applied with typical TCGplayer condition spreads to the near-mint market price.",
      } : null,
      allPrintings,
    },
    model,
  };
}

/** Cards on Lazy's shelf / in the sales log that look like the scanned card. */
export function shopMatches<T extends { name: string; set?: string; number?: string }>(rows: T[], res: ScanResult): T[] {
  const local = normLocal(numberParts(res.match.number).local);
  const nameWords = words(res.match.name);
  return rows.filter((x) => {
    const xn = normLocal(numberParts(x.number ?? "").local);
    const named = nameWords.length > 0 && nameWords.every((w) => words(x.name).includes(w));
    return named && (!local || !xn || xn === local);
  }).slice(0, 10);
}

export const exampleScan = {
  ok: true,
  read: { isPokemonCard: true, name: "Zangoose", number: "21/106", setName: "EX Emerald", setCode: null, language: "en", foil: "reverse", firstEdition: false, condition: "NM", conditionNotes: "clean corners, no visible whitening", confidence: 0.9 },
  match: { id: "ex9-21", name: "Zangoose", number: "21/106", set: "Emerald", setId: "ex9", setTotal: 106, rarity: "Rare", image: "https://assets.tcgdex.net/en/ex/ex9/21/high.webp", language: "en", score: 9.75 },
  alternatives: [],
  prices: { source: "TCGplayer via TCGdex", currency: "USD", updated: "2026-11-12T00:00:00Z", printing: "reverse-holofoil", nearMint: { market: 47.75, low: 40, mid: 50, high: 70 }, conditionEstimate: { condition: "NM", market: 47.75, note: "Estimate: ..." }, allPrintings: { normal: { market: 9.1, low: 6 }, "reverse-holofoil": { market: 47.75, low: 40 } } },
  shop: { listed: [], sold: [] },
  model: "@cf/meta/llama-4-scout-17b-16e-instruct",
};
