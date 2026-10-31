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
  const stores: string[] = truthy(round_.einkauf_laeden) ? round_.einkauf_laeden
    : truthy(o.retailers) ? o.retailers : [...new Set(Object.values<Obj>(found).flatMap((v) => Object.keys(v)))].sort(cmp);
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
export async function deals_digest(hh: Household, db: Obj, day: string, limit = 25, stores: string[] = []): Promise<string> {
  const found = await fetch_offers(hh, db, day);
  const lines: [number, string][] = [];
  for (const [k, all] of Object.entries<Obj>(found)) {
    const perStore = stores.length ? Object.fromEntries(Object.entries<Obj>(all).filter(([id]) => stores.includes(id))) : all;
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

/** The `n` stores whose leaflets together have the most categories at or near (+15 %) the best price per kg. */
export function pick_stores(found: Obj, n: number): string[] {
  const best: Record<string, Record<string, number>> = {}; // term → store → cheapest €/kg
  for (const [t, rows] of Object.entries<Obj[]>(found)) for (const r of rows) {
    if (!r.grundpreis || !["kg", "l"].includes(String(r.einheit).toLowerCase())) continue;
    for (const id of String(r.laden_id).split(",")) if (!((best[t] ??= {})[id] <= r.grundpreis)) best[t][id] = r.grundpreis;
  }
  const all = [...new Set(Object.values(best).flatMap((m) => Object.keys(m)))].sort(cmp);
  const score = (set: string[]) => Object.values(best).reduce((sum, m) => {
    const mine = Math.min(...set.map((x) => m[x] ?? Infinity));
    return sum + (mine <= Math.min(...Object.values(m)) * 1.15 ? 1 : mine < Infinity ? 0.3 : 0);
  }, 0);
  const sets = (from: string[], k: number): string[][] =>
    k === 0 ? [[]] : from.flatMap((x, i) => sets(from.slice(i + 1), k - 1).map((rest) => [x, ...rest]));
  let top: string[] = [];
  for (const set of sets(all, Math.min(n, all.length))) if (score(set) > score(top)) top = set;
  return top;
}

/** Raw leaflet offers per `offers.browse` term for `day`, excluded words dropped. Cached per day; null when off or unreachable. */
async function browse_raw(hh: Household, day: string): Promise<Obj | null> {
  const o = hh.offers, terms: string[] = o.browse ?? [];
  if (!o.enabled || !o.zip || !terms.length) return null;
  const cacheFile = path.join(hh.paths.jobs, `browse-${o.zip}-${day}.json`);
  const found: Obj = fs.existsSync(cacheFile) ? JSON.parse(readText(cacheFile)) : {};
  const todo = terms.filter((t) => !Object.hasOwn(found, t));
  if (todo.length) {
    let keys: [string, string];
    try {
      keys = await offers.get_keys();
    } catch (e) {
      if (e instanceof offers.OffersError) return null;
      throw e;
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (next < todo.length) {
        const t = todo[next++];
        try { found[t] = await offers.search(t, o.zip, keys, day, o.retailers, 100) } catch (e) { if (!(e instanceof offers.OffersError)) throw e }
      }
    }));
    fs.writeFileSync(cacheFile, dumps(found), "utf-8");
  }
  const bad = hh.exclusions.map((x) => x.toLowerCase());
  const ok = (r: Obj) => !bad.some((b) => `${r.marke} ${r.produkt}`.toLowerCase().includes(b));
  return Object.fromEntries(terms.filter((t) => found[t]).map((t) => [t, found[t].filter(ok)]));
}

/** Stores a household may pick: known ids only, at most `offers.max_stores`. */
const valid_stores = (hh: Household, ids: unknown): string[] =>
  (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && Object.hasOwn(offers.RETAILERS, id)).slice(0, Number(hh.offers.max_stores) || 2);

/** The week's whole leaflet for the `offers.browse` search terms, as idea input for Claude: one line per offer,
 * grouped by term, limited to `only` stores or the best `offers.max_stores`. Empty when not configured or unreachable. */
export async function browse_digest(hh: Household, day: string, only: string[] = [], perTerm = 12): Promise<{ text: string; stores: string[] }> {
  const o = hh.offers, terms: string[] = o.browse ?? [];
  const found = await browse_raw(hh, day);
  if (!found) return { text: "", stores: [] };
  const seen = new Set<string>(), mine = valid_stores(hh, only);
  const stores = mine.length ? mine : pick_stores(found, Number(o.max_stores) || 2);
  const blocks = terms.map((t) => {
    // cheapest per kg first, taken round-robin per store so every store shows up;
    // the same offer is often listed twice under different ids
    const byStore = new Map<string, string[]>();
    for (const r of [...(found[t] ?? [])].sort((a: Obj, b: Obj) => (a.grundpreis ?? Infinity) - (b.grundpreis ?? Infinity))) {
      if (!String(r.laden_id).split(",").some((id) => stores.includes(id))) continue;
      const l = `- ${`${r.marke || ""} ${r.produkt}`.trim()} · ${r.laden} · ${fmtFixed(r.preis ?? 0, 2)} €`
        + (r.grundpreis ? ` (${fmtFixed(r.grundpreis, 2)} €/${r.einheit || "kg"})` : "") + (r.gueltig_bis ? ` · until ${r.gueltig_bis}` : "");
      if (seen.has(l)) continue;
      seen.add(l);
      byStore.set(r.laden, [...(byStore.get(r.laden) ?? []), l]);
    }
    const lines: string[] = [];
    for (let i = 0; lines.length < perTerm && [...byStore.values()].some((ls) => ls.length > i); i++)
      for (const ls of byStore.values()) if (ls[i] && lines.length < perTerm) lines.push(ls[i]);
    return lines.length ? `## ${t}\n${lines.join("\n")}` : "";
  }).filter(Boolean);
  return { text: blocks.join("\n"), stores };
}

/** A trustworthy normal price per kg: an explicit regular price, or one from a receipt / the base list —
 * not an estimate and not an earlier offer price (an offer would be compared with itself). 0 = unknown. */
export function normal_eur_kg(z: Obj): number {
  const q = String(z?.quelle ?? "");
  return Number(z?.regulaer_eur_kg ?? (q.startsWith("schaetzung") || q.startsWith("angebot") ? 0 : z?.eur_kg ?? 0)) || 0;
}

/** Is the offer really cheaper? Compared with the household's own normal price per kg of the matching ingredient
 * (`muss`/`nicht` patterns of the ingredient list) and, when the store gives one, its "instead of" price. */
export function verdict(db: Obj, r: Obj): Obj {
  const name = `${r.marke || ""} ${r.produkt}`.toLowerCase(), unit = String(r.einheit).toLowerCase();
  // same ingredient only if every word of its search term is in the name (the patterns alone are too loose across
  // all offers: "Landhähnchen Flügel" would pass as yoghurt); the most specific match wins, none beats a wrong one
  const words = (t: string) => t.toLowerCase().match(/[a-zäöüß]+/g) ?? [], nameWords = words(name);
  const key = Object.keys(db).sort(cmp).filter((k) => typeof db[k] === "object" && db[k]?.suche
    && words(String(db[k].suche)).every((w) => nameWords.some((n) => n.startsWith(w))) && (!db[k].muss || new RegExp(db[k].muss).test(name))
    && !(db[k].nicht && new RegExp(db[k].nicht).test(name)))
    .sort((a, b) => words(String(db[b].suche)).length - words(String(db[a].suche)).length)[0];
  const z = key ? db[key] : {}, normal = normal_eur_kg(z);
  const out: Obj = { zutat: key ? db[key].name : null, normal_eur_kg: normal || null };
  if (r.alter_preis > r.preis) out.laden_rabatt = Math.round((1 - r.preis / r.alter_preis) * 100);
  const vs = normal && r.grundpreis && (unit === "kg" || unit === "l") ? Math.round((r.grundpreis / normal - 1) * 100) : null;
  if (vs !== null && vs <= 60) { // far above normal is a different product (organic, buffalo, spice), not a fake deal
    out.vs_normal = vs;
    out.urteil = vs <= -10 ? "echt" : vs < 0 ? "knapp" : "schein";
  } else {
    out.normal_eur_kg = null;
    out.urteil = out.laden_rabatt ? "laut_laden" : "unbekannt";
  }
  return out;
}

/** Everything on offer this week, by category and store, each with its verdict — for the household to browse. */
export async function deals_overview(hh: Household, db: Obj, day: string, chosen: string[]): Promise<Obj> {
  const found = await browse_raw(hh, day) ?? {};
  const seen = new Set<string>(), count: Obj = {};
  const kategorien = Object.entries<Obj[]>(found).map(([name, rows]) => ({
    name,
    angebote: rows.filter((r) => { const k = `${r.marke}|${r.produkt}|${r.laden}|${r.preis}`; return !seen.has(k) && !!seen.add(k); })
      .sort((a, b) => (a.grundpreis ?? Infinity) - (b.grundpreis ?? Infinity))
      .map((r) => {
        for (const id of String(r.laden_id).split(",")) count[id] = (count[id] ?? 0) + 1;
        return { ...pick_keys(r, ["produkt", "marke", "laden", "laden_id", "preis", "alter_preis", "grundpreis", "einheit", "gueltig_bis", "treueprogramm"]), ...verdict(db, r) };
      }),
  })).filter((k) => k.angebote.length);
  const laeden = Object.keys(count).sort((a, b) => count[b] - count[a]).map((id) => ({ id, name: offers.RETAILERS[id] ?? id, angebote: count[id] }));
  return { stichtag: day, plz: hh.offers.zip, max: Number(hh.offers.max_stores) || 2, gewaehlt: valid_stores(hh, chosen), laeden, kategorien };
}

const pick_keys = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

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
