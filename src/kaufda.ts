// Offers from kaufDA's public offer pages (kaufda.de/Angebote/<term>), read with a real browser (Playwright,
// an optional dependency). robots.txt allows these pages with a 2 s crawl delay; kaufDA's terms allow the data for
// private use only. The location is the one kaufDA derives from the connection (the household's own network).
import type { Obj } from "./py.ts";

/** kaufDA publisher → our retailer id; unknown publishers are skipped */
const IDS: Record<string, string> = {
  "aldi süd": "aldi-sued", "aldi nord": "aldi-nord", lidl: "lidl", "netto marken-discount": "netto-marken-discount",
  penny: "penny", norma: "norma", kaufland: "kaufland", rewe: "rewe", nahkauf: "rewe", edeka: "edeka", "e center": "edeka", marktkauf: "edeka",
};
export const timing = { gap: 2000 };

/** "(6.23 / kg)", "(1 kg = 18.73)", "(App: 4.36 / kg)" → [6.23, "kg"]; null without a price per kg or litre. */
export function base_price(s: unknown): [number, string] | null {
  const t = String(s ?? "");
  const a = t.match(/1\s*(kg|l)\s*=\s*([\d.,]+)/i), b = t.match(/([\d.,]+)\s*\/\s*(kg|l)\b/i);
  const [num, unit] = a ? [a[2], a[1]] : b ? [b[1], b[2]] : [];
  return num ? [Number(num.replace(",", ".")), unit!.toLowerCase()] : null;
}

const berlinDay = (s: unknown) => (s ? new Date(String(s).replace("+0000", "Z")).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) : "");

/** One kaufDA offer card → the same row shape as a marktguru offer. */
export function normalize(it: Obj): Obj | null {
  const laden_id = IDS[String(it?.publisherName ?? "").toLowerCase()];
  const p = it?.prices ?? {};
  if (!laden_id || !(p.mainPrice > 0) || !it.title) return null; // coupon cards ("10% Rabatt") have no price
  const bp = base_price(p.priceByBaseUnit);
  return {
    produkt: String(it.title), marke: "", laden: String(it.publisherName), laden_id,
    preis: p.mainPrice, grundpreis: bp?.[0] ?? null, einheit: bp?.[1] ?? "",
    gueltig_von: berlinDay(it.validFrom), gueltig_bis: berlinDay(it.validUntil),
    treueprogramm: /app:/i.test(String(p.priceByBaseUnit ?? "")), id: `kaufda-${it.id}`, quelle: "kaufDA",
    ...(p.secondaryPriceIsUVP && p.secondaryPrice > p.mainPrice ? { alter_preis: p.secondaryPrice } : {}),
  };
}

/** Offers per term valid on `day` at `retailers` (all if empty); null when Playwright or its browser is missing. */
export async function search_all(terms: string[], day: string, retailers: string[] = []): Promise<Record<string, Obj[]> | null> {
  let pw: any;
  try {
    const name = "playwright";
    pw = await import(name);
  } catch {
    return null;
  }
  let browser: any;
  try {
    browser = await pw.chromium.launch();
  } catch (e) {
    console.error("kaufDA: no browser for Playwright (npx playwright install chromium)", e);
    return null;
  }
  const out: Record<string, Obj[]> = {};
  try {
    const page = await browser.newPage({ locale: "de-DE" });
    for (const [i, t] of terms.entries()) {
      if (i) await new Promise((r) => setTimeout(r, timing.gap)); // crawl-delay from robots.txt
      try {
        await page.goto(`https://www.kaufda.de/Angebote/${encodeURIComponent(t)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        // runs in the page: the offers kaufDA renders into its Next.js data
        const items: Obj[] = await page.evaluate(() => {
          const doc = (globalThis as any).document;
          try { return JSON.parse(doc.getElementById("__NEXT_DATA__").textContent).props.pageProps.pageInformation.offers.main.items ?? [] } catch { return [] }
        });
        out[t] = items.map(normalize).filter((r): r is Obj => !!r && r.gueltig_von <= day && day <= r.gueltig_bis
          && (!retailers.length || retailers.includes(r.laden_id)));
      } catch (e) {
        console.error(`kaufDA: ${t}`, e);
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}
