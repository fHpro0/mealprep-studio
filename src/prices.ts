// Compare ingredient prices across every configured retailer near the household.
//
// Only *offers* are public. Without an offer we fall back to the ingredient's regular price estimate
// (`regulaer_eur_kg`, else `eur_kg`), multiplied by the retailer markup from household.toml.
// Results are cached per shopping day, so a second round on the same day costs no network calls.
import fs from "node:fs";
import path from "node:path";
import { packs } from "./calc.ts";
import type { Household } from "./config.ts";
import * as offers from "./offers.ts";
import { dumps, fmtFixed, need, pyRound, readText, truthy, type Obj } from "./py.ts";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function _best_per_retailer(z: Obj, rows: Obj[]): Obj {
  const best: Obj = {};
  for (const a of rows) {
    const name = `${a.marke || ""} ${a.produkt}`.toLowerCase();
    if (!new RegExp(z.muss ?? ".").test(name) || (z.nicht && new RegExp(z.nicht).test(name))) continue;
    const g = a.grundpreis, unit = (a.einheit || "").toLowerCase();
    if (!g) continue;
    let eur_kg: number;
    if (unit === "kg" || unit === "l") eur_kg = g;
    else if ((unit === "stk" || unit === "stück") && z.stueck_g) eur_kg = g / (z.stueck_g / 1000);
    else continue;
    for (const lid of a.laden_id.split(",")) {
      if (!Object.hasOwn(best, lid) || eur_kg < best[lid].eur_kg) {
        best[lid] = {
          laden: offers.RETAILERS[lid] ?? a.laden, produkt: `${a.marke || ""} ${a.produkt}`.trim(), preis: a.preis,
          eur_kg: pyRound(eur_kg, 2), bis: a.gueltig_bis ?? null, treue: need(a, "treueprogramm"),
        };
      }
    }
  }
  return best;
}

/** {ingredient: {retailer_id: best offer}} — cached per day in the jobs folder. */
export async function fetch_offers(hh: Household, db: Obj, day: string, keysNeeded?: Set<string>): Promise<Obj> {
  const o = hh.offers;
  if (!o.enabled || !o.zip) return {};
  const cacheFile = path.join(hh.paths.jobs, `offers-${o.zip}-${day}.json`);
  const cache: Obj = fs.existsSync(cacheFile) ? JSON.parse(readText(cacheFile)) : {};
  const todo = [...(keysNeeded?.size ? keysNeeded : Object.keys(db))].filter((k) => Object.hasOwn(db, k) && db[k].suche && !Object.hasOwn(cache, k));
  if (todo.length) {
    let apiKeys: [string, string];
    try {
      apiKeys = await offers.get_keys();
    } catch (e) {
      if (e instanceof offers.OffersError) return cache;
      throw e;
    }
    const one = async (k: string): Promise<[string, Obj | null]> => {
      try {
        return [k, _best_per_retailer(db[k], await offers.search(db[k].suche, o.zip, apiKeys, day, o.retailers))];
      } catch (e) {
        if (e instanceof offers.OffersError) return [k, null];
        throw e;
      }
    };
    // ThreadPoolExecutor(8): at most 8 searches in flight, results applied in input order
    const results: [string, Obj | null][] = new Array(todo.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (next < todo.length) {
        const i = next++;
        results[i] = await one(todo[i]);
      }
    }));
    for (const [k, best] of results) if (best !== null) cache[k] = best;
    fs.writeFileSync(cacheFile, dumps(cache), "utf-8");
  }
  return cache;
}

/** Price file for one round (what the web app uses for the 'where to shop' view). */
export async function compare(hh: Household, db: Obj, round_: Obj, day: string): Promise<Obj | null> {
  const o = hh.offers;
  if (!o.enabled) return null;
  const keys = new Set<string>();
  for (const k of round_.kandidaten) for (const l of k.berechnet?.einkaufsliste ?? []) keys.add(l.zutat);
  const found = await fetch_offers(hh, db, day, keys);
  const stores: string[] = truthy(o.retailers) ? o.retailers : [...new Set(Object.values<Obj>(found).flatMap((v) => Object.keys(v)))].sort(cmp);
  const laeden: Obj = {};
  for (const l of stores) laeden[l] = offers.RETAILERS[l] ?? l;
  const zutaten: Obj = {};
  for (const k of [...keys].sort(cmp)) {
    if (!Object.hasOwn(db, k)) continue;
    const angebote: Obj = {};
    for (const [l, v] of Object.entries(found[k] ?? {})) if (stores.includes(l)) angebote[l] = v;
    zutaten[k] = {
      name: need(db[k], "name"), standard_eur_kg: need(db[k], "eur_kg"),
      regulaer_eur_kg: db[k].regulaer_eur_kg ?? db[k].eur_kg, pack_g: need(db[k], "pack_g"), angebote,
    };
  }
  return { stichtag: day, plz: o.zip, laeden, aufschlag: o.markup, zweiter_laden_ab: o.second_store_min_saving, zutaten };
}

/** Short text for the planning prompt: ingredients that are clearly cheaper this week. */
export async function deals_digest(hh: Household, db: Obj, day: string, limit = 25): Promise<string> {
  const found = await fetch_offers(hh, db, day);
  const lines: [number, string][] = [];
  for (const [k, perStore] of Object.entries<Obj>(found)) {
    if (!truthy(perStore)) continue;
    let best: Obj | undefined;
    for (const v of Object.values<Obj>(perStore)) if (!best || v.eur_kg < best.eur_kg) best = v; // min(): first minimum wins
    const regular = db[k].regulaer_eur_kg ?? need(db[k], "eur_kg");
    if (best!.eur_kg < regular * 0.9) {
      lines.push([best!.eur_kg / regular, `- ${k}: ${fmtFixed(best!.eur_kg, 2)}/kg at ${best!.laden} (regular ~${fmtFixed(regular, 2)}) until ${best!.bis}`]);
    }
  }
  lines.sort((a, b) => a[0] - b[0] || cmp(a[1], b[1]));
  return lines.slice(0, limit).map((l) => l[1]).join("\n") || "(no notable offers)";
}

/** Pick one store, or two if that saves at least `minSaving`. Returns {stores, total, rows}. */
export function plan_stores(prices: Obj | null, items: Obj[], minSaving: number): Obj {
  const priceIn = (store: string | null, it: Obj): [number, Obj | null] => {
    const p = prices?.zutaten?.[it.zutat];
    const markup = store === null ? 1 : prices?.aufschlag?.[store] ?? 1;
    const base = (p ? p.regulaer_eur_kg : it.eur_kg) * markup;
    const a = store === null ? undefined : p?.angebote?.[store];
    return a && a.eur_kg < base ? [a.eur_kg, a] : [base, null];
  };
  const cost = (stores: (string | null)[]): [number, Obj[]] => {
    const rows: Obj[] = [];
    let total = 0;
    for (const it of items) {
      if (it.laden === "Vorrat") continue;
      let best: [[number, Obj | null], string | null] | undefined;
      for (const s of stores) {
        const pr = priceIn(s, it);
        if (!best || pr[0] < best[0][0]) best = [pr, s];
      }
      const [[eur_kg, offer], store] = best!;
      const n = packs(it.g, it.pack_g);
      const eur = pyRound((n * it.pack_g) / 1000 * eur_kg, 2);
      total += eur;
      rows.push({ ...it, packungen: n, eur, laden_plan: store, angebot: offer });
    }
    return [total, rows];
  };

  if (!prices) {
    const [total, rows] = cost([null]);
    return { stores: [], total: pyRound(total, 2), rows };
  }
  const stores: string[] = Object.keys(prices.laeden);
  const singles = stores.map((s) => ({ c: cost([s]), s: [s] })).sort((a, b) => a.c[0] - b.c[0]);
  let [bestTotal, bestRows] = singles[0].c;
  let bestStores = singles[0].s;
  stores.forEach((a, i) => {
    for (const b of stores.slice(i + 1)) {
      const [t, rows] = cost([a, b]);
      if (t < bestTotal - minSaving) [bestTotal, bestRows, bestStores] = [t, rows, [a, b]];
    }
  });
  return { stores: bestStores, total: pyRound(bestTotal, 2), rows: bestRows };
}
