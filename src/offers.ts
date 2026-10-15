// Supermarket offers by postcode via marktguru.de (Germany and Austria only).
//
// The public web app embeds its API keys in the page HTML; they are read fresh on every run because
// marktguru rotates them. This is an unofficial interface — it may break or change at any time, and
// you are responsible for using it in line with marktguru's terms. Disable with [offers] enabled = false.
import { pyQuote, type Obj } from "./py.ts";

export const HOME_URL = "https://marktguru.de";
export const API_URL = "https://api.marktguru.de/api/v1/offers/search";
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// marktguru retailer ids for the chains most people mean
export const RETAILERS: Record<string, string> = {
  "aldi-sued": "Aldi Süd", "aldi-nord": "Aldi Nord", lidl: "Lidl", "netto-marken-discount": "Netto",
  penny: "Penny", norma: "Norma", kaufland: "Kaufland", rewe: "Rewe", edeka: "Edeka",
  globus: "Globus", marktkauf: "Marktkauf", hit: "HIT", spar: "Spar", billa: "Billa", hofer: "Hofer",
};

export class OffersError extends Error {}

async function _fetch(url: string, headers: Obj = {}, timeout = 30): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(timeout * 1000) });
  } catch (e: any) {
    throw new OffersError(`network error: ${e?.cause?.message ?? e?.message ?? e}`);
  }
  if (!res.ok) throw new OffersError(`HTTP ${res.status} from ${new URL(url).host}`);
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
}

export async function get_keys(): Promise<[string, string]> {
  const html = await _fetch(HOME_URL);
  const found = [...html.matchAll(/<script\s+type="application\/json"[^>]*>(.*?)<\/script>/gs)].map((m) => m[1]);
  for (const raw of found.reverse()) {
    let cfg: Obj;
    try {
      cfg = JSON.parse(raw)?.config || {};
    } catch {
      continue;
    }
    if (cfg.apiKey && cfg.clientKey) return [cfg.apiKey, cfg.clientKey];
  }
  throw new OffersError("no API keys found on marktguru.de — page layout changed; continue without offers");
}

const covers = (row: Obj, day: string): boolean => {
  const start = row.gueltig_von || "", end = row.gueltig_bis || "";
  return !((start && day < start) || (end && day > end));
};

function brand(offer: Obj): string {
  const name = (offer.brand?.name || "").trim();
  const unique = (offer.brand?.uniqueName || "").trim().toLowerCase();
  if (!name || unique.includes("nobrand") || name.toLowerCase().replace(/ /g, "").includes("nobrand")) return "";
  return name;
}

function normalize(offer: Obj): Obj {
  const advertisers: Obj[] = offer.advertisers || [];
  const ranges: Obj[] = offer.validityDates || [];
  return {
    produkt: offer.product?.name || offer.description || "?",
    marke: brand(offer),
    laden: advertisers.map((a) => a.name ?? "").join(", "),
    laden_id: advertisers.map((a) => a.uniqueName ?? "").join(","),
    preis: offer.price ?? null,
    grundpreis: offer.referencePrice ?? null,
    einheit: offer.unit?.shortName || "",
    gueltig_von: ranges.length ? (ranges[0].from || "").slice(0, 10) : "",
    gueltig_bis: ranges.length ? (ranges[0].to || "").slice(0, 10) : "",
    treueprogramm: !!offer.requiresLoyalityMembership,
    id: offer.id ?? null,
  };
}

export async function search(query: string, zipCode: string, keys: [string, string], day: string, retailers?: string[], limit = 40): Promise<Obj[]> {
  const [apiKey, clientKey] = keys;
  // urllib.parse.urlencode = quote_plus
  const params = Object.entries({ as: "web", q: query, zipCode, limit, offset: 0 })
    .map(([k, v]) => `${k}=${pyQuote(String(v), "").replace(/%20/g, "+")}`).join("&");
  const headers = { "x-apikey": apiKey, "x-clientkey": clientKey, Accept: "application/json" };
  let payload: Obj;
  try {
    payload = JSON.parse(await _fetch(`${API_URL}?${params}`, headers));
  } catch (e) {
    if (e instanceof SyntaxError) throw new OffersError("marktguru answer was not JSON");
    throw e;
  }
  const rows: Obj[] = (payload.results || []).map(normalize);
  const wanted = new Set(retailers || []);
  return rows.filter((r) => covers(r, day) && (!wanted.size || r.laden_id.split(",").some((x: string) => wanted.has(x))));
}
