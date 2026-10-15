// Ingredient database + nutrition/portion/cost calculator.
//
// A candidate carries a "rechnung" block:
//     {"slot": "<meal id>", "haupt": {"<ingredient>": grams_total}, "pro_portion": {"<ingredient>": grams}}
//
// "haupt" is cooked once for everybody and split by weight; "pro_portion" is the same for every
// portion (rice, salad). The main quantities are scaled so every person hits their meal target —
// quantities change, the target does not.
import fs from "node:fs";
import path from "node:path";
import { REPO, type Household } from "./config.ts";
import { KeyError, div, dumps, has, need, pyRound, pySum, readText, truthy, type Obj } from "./py.ts";

const PANTRY_STORES = new Set(["vorrat", "pantry"]);
const readJson = (p: string) => JSON.parse(readText(p));

/** Default database merged with the household's own, per key and per field: household fields win,
 * fields the household entry omits (e.g. `aisle`) fall back to the default entry. */
export function load_ingredients(hh: Household): Obj {
  const db: Obj = readJson(path.join(REPO, "data", "ingredients.json"));
  const own = hh.paths.ingredients;
  if (fs.existsSync(own)) {
    for (const [k, v] of Object.entries<any>(readJson(own))) {
      if (k.startsWith("_")) continue;
      const cur = db[k];
      db[k] = cur && typeof cur === "object" && !Array.isArray(cur) && v && typeof v === "object" && !Array.isArray(v) ? { ...cur, ...v } : v;
    }
  }
  return Object.fromEntries(Object.entries(db).filter(([k]) => !k.startsWith("_")));
}

/** Persist agent-proposed ingredients into the household database. Never overwrites. */
export function add_ingredients(hh: Household, added_: Obj | null | undefined): string[] {
  if (!truthy(added_)) return [];
  const f = hh.paths.ingredients;
  const own: Obj = fs.existsSync(f) ? readJson(f) : {};
  const known = load_ingredients(hh);
  const added: string[] = [];
  for (const [k, v] of Object.entries<any>(added_!)) {
    if (Object.hasOwn(known, k) || Object.hasOwn(own, k)) continue;
    own[k] = { ...v, quelle: v.quelle ?? "schaetzung" };
    added.push(k);
  }
  if (added.length) fs.writeFileSync(f, dumps(own, 1) + "\n", "utf-8");
  return added;
}

export function is_pantry(z: Obj): boolean {
  return truthy(z.pantry) || PANTRY_STORES.has(String(z.laden ?? "").toLowerCase());
}

export function macros(db: Obj, amounts: Obj): Obj {
  const out: Obj = { kcal: 0, p: 0, kh: 0 };
  for (const [k, g] of Object.entries<number>(amounts)) {
    if (!Object.hasOwn(db, k)) throw new KeyError(k);
    for (const m of Object.keys(out)) out[m] += (need(db[k], m) * g) / 100;
  }
  return out;
}

export function packs(g: number, packG: number): number {
  return Math.max(1, Math.ceil(div(g, packG) - 0.03)); // 3 % tolerance: 1,010 g from a 1 kg pack is one pack
}

export function calculate(hh: Household, db: Obj, cand: Obj): Obj {
  const r = need(cand, "rechnung");
  const slot = r.slot || need(cand, "slot");
  const persons: string[] = hh.persons.map((p) => p.id);
  const n = hh.days;
  const fix = macros(db, r.pro_portion ?? {});
  let main = macros(db, need(r, "haupt"));
  const targets: Obj = {};
  for (const p of persons) targets[p] = hh.meal_target(slot, p);
  const needed = pySum(persons.map((p) => n * (targets[p] - fix.kcal)));
  const factor = main.kcal ? needed / main.kcal : 1;
  const amounts: Obj = {};
  for (const [k, g] of Object.entries<number>(r.haupt)) amounts[k] = pyRound((g * factor) / 10) * 10 || g;
  main = macros(db, amounts);
  const share: Obj = {};
  for (const p of persons) share[p] = div(targets[p] - fix.kcal, main.kcal);
  const per_person: Obj = {};
  for (const p of persons) {
    per_person[p] = {};
    for (const m of Object.keys(main)) per_person[p][m] = pyRound(share[p] * main[m] + fix[m]);
  }

  const total: Obj = { ...amounts };
  for (const [k, g] of Object.entries<number>(r.pro_portion ?? {})) total[k] = (total[k] ?? 0) + g * n * persons.length;
  const shopping: Obj[] = [];
  let cost = 0;
  for (const [k, g] of Object.entries<number>(total)) {
    const z = db[k];
    const base = need(z, "name");
    const name = hh.language === "de" ? base : has(z, `name_${hh.language}`) ? z[`name_${hh.language}`] : base;
    const row: Obj = {
      zutat: k, name, g, pack_g: need(z, "pack_g"), eur_kg: need(z, "eur_kg"),
      laden: z.laden ?? "", quelle: z.quelle ?? "", aisle: z.aisle ?? "other",
    };
    if (is_pantry(z)) {
      Object.assign(row, { packungen: 0, eur: 0, laden: "Vorrat" });
    } else {
      row.packungen = packs(g, z.pack_g);
      row.eur = pyRound((row.packungen * z.pack_g) / 1000 * z.eur_kg, 2);
      cost += row.eur;
    }
    shopping.push(row);
  }

  const warnings: string[] = [];
  if (Math.abs(factor - 1) > 0.15) {
    const pct = pyRound((factor - 1) * 100);
    warnings.push(`main quantities scaled ${pct >= 0 ? "+" : "-"}${Math.abs(pct)} %`);
  }
  const shares: Obj = {};
  for (const [p, s] of Object.entries<number>(share)) shares[p] = pyRound(s, 4);
  cand.berechnet = {
    mengen: amounts, anteil: shares, makros: per_person, kosten: { einkauf: pyRound(cost, 2) },
    einkaufsliste: shopping, skalierung: pyRound(factor, 3), warnungen: warnings,
  };
  cand.makros = per_person;
  cand.kosten = pyRound(cost, 2);
  return cand;
}

/** Hard safety net: excluded words in title, subtitle or ingredients ("ohne X"/"without X" is fine). */
export function check_exclusions(hh: Household, db: Obj, cand: Obj): string[] {
  let text = ["titel", "untertitel"].map((k) => String(cand[k] ?? "")).join(" ").toLowerCase();
  const parts: string[] = [];
  for (const part of ["haupt", "pro_portion"]) {
    for (const k of Object.keys(cand.rechnung?.[part] ?? {})) parts.push((db[k]?.name ?? k).toLowerCase() + " " + k);
  }
  text += " " + parts.join(" ");
  const hits: string[] = [];
  for (const w of hh.exclusions) {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    for (const m of text.matchAll(re)) {
      // Python slices by code point; the 20-char window only matters for astral characters
      if (!/(ohne|without|kein|keine|no|free)[\s-]+\S*$/.test(text.slice(Math.max(0, m.index! - 20), m.index!))) {
        hits.push(w);
        break;
      }
    }
  }
  return hits;
}
