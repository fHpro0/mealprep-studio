// The four actions behind the web buttons: new round, revise, plan, feedback.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as agent from "./agent.ts";
import * as calc from "./calc.ts";
import { WEEKDAYS, type Household } from "./config.ts";
import * as images from "./images.ts";
import * as plate from "./plate.ts";
import * as prices from "./prices.ts";
import { RETAILERS } from "./offers.ts";
import { week_markdown } from "./render.ts";
import {
  KeyError, ZeroDivisionError, addDays, clock, ddmm, dmy, dumps, fmtFixed, fmtThousands, floatStr, fromIso, iso, need,
  nowIso, pyRound, pySum, readText, stamp, today, truthy, weekday, year, mkdirp, type Obj,
} from "./py.ts";

export { clock };
export type Progress = (phase: string) => void;

const DAY_NAMES: Record<string, string[]> = {
  de: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
};
const ID = /^\d{4}-\d{2}-\d{2}$/;
/** photo downloads still running after an action returns */
export const BACKGROUND = new Set<Promise<void>>();

// ---------- small helpers -------------------------------------------------------------------
export const now = nowIso;

export function read(p: string, dflt: any = undefined): any {
  return fs.existsSync(p) ? JSON.parse(readText(p)) : dflt;
}

/** Write JSON. If the file exists and backupDir is given, keep a timestamped copy first. */
export function write(p: string, data: any, backupDir?: string): void {
  if (backupDir && fs.existsSync(p)) {
    mkdirp(backupDir);
    const { name, ext } = path.parse(p);
    fs.copyFileSync(p, path.join(backupDir, `${name}.${stamp()}${ext}`));
  }
  fs.writeFileSync(p, dumps(data, 2) + "\n", "utf-8");
}

export function ids(folder: string): string[] {
  return fs.readdirSync(folder).filter((f) => f.endsWith(".json") && ID.test(f.slice(0, -5))).map((f) => f.slice(0, -5)).sort();
}

export function fmt_day(hh: Household, d: Date): string {
  return `${(DAY_NAMES[hh.language] ?? DAY_NAMES.en)[weekday(d)]} ${ddmm(d)}`;
}

const mod7 = (n: number) => ((n % 7) + 7) % 7;
const weekdayIndex = (day: string) => {
  const i = WEEKDAYS.indexOf(day);
  if (i < 0) throw new Error(`'${day}' is not in list`);
  return i;
};

/** Next round starts on the configured first eating day after the latest week/round. */
export function round_dates(hh: Household): Obj {
  const s = hh.schedule;
  const all = [...ids(hh.paths.weeks), ...ids(hh.paths.rounds)];
  const latest = all.length ? all.reduce((a, b) => (b > a ? b : a)) : iso(today());
  const next = addDays(fromIso(latest), 1);
  const base = next > today() ? next : today();
  const first = addDays(base, mod7(weekdayIndex(s.first_day) - weekday(base)));
  const before = (day: string) => addDays(first, -(mod7(weekday(first) - weekdayIndex(day)) || 7)); // last <day> before `first`
  const shop = before(s.shopping_day), prep = before(s.prep_day), last = addDays(first, hh.days - 1);
  return {
    id: iso(first), zeitraum: `${fmt_day(hh, first)} – ${fmt_day(hh, last)}${year(last)}`,
    einkaufstag: fmt_day(hh, shop), einkauf_iso: iso(shop), preptag: fmt_day(hh, prep),
  };
}

// ---------- candidate processing -------------------------------------------------------------
/** Merge kept dishes, calculate, flag exclusions. Returns (candidates, notes). */
export function process_candidates(hh: Household, db: Obj, cands: Obj[], old: Record<string, Obj>): [Obj[], string[]] {
  const out: Obj[] = [], notes: string[] = [];
  for (const c of cands) {
    if (truthy(c.keep) && Object.hasOwn(old, c.id)) {
      out.push({ ...old[c.id], neu: false, antwort: c.antwort ?? "" });
      continue;
    }
    delete c.keep;
    c.rechnung ??= {};
    c.rechnung.pro_portion ??= {};
    c.rechnung.slot = need(c, "slot");
    try {
      calc.calculate(hh, db, c);
    } catch (e) {
      if (e instanceof KeyError) notes.push(`dropped ${c.titel ?? c.id}: unknown ingredient ${e.message}`);
      else if (e instanceof ZeroDivisionError) notes.push(`dropped ${c.titel ?? c.id}: no main ingredients`);
      else throw e;
      continue;
    }
    const bad = calc.check_exclusions(hh, db, c);
    if (bad.length) {
      notes.push(`dropped ${c.titel ?? c.id}: contains excluded ${bad.join(", ")}`);
      continue;
    }
    const prev = Object.hasOwn(old, c.id) ? old[c.id] : undefined;
    c.neu = prev === undefined || !isDeepStrictEqual(prev.rechnung?.haupt, c.rechnung.haupt);
    c.bild = prev && prev.bild_suche === c.bild_suche ? prev.bild ?? "" : "";
    if (Array.isArray(c.teller) && c.teller.length && SAFE_ID.test(String(c.id))) {
      // drawn plate instead of a stock photo; ?v= busts the browser cache when the dish changes
      const svg = plate.render(c.id, c.titel ?? c.id, c.teller, !truthy(hh.meals.find((m) => m.id === c.slot)?.cold)), dir = path.join(hh.paths.images, "kandidaten");
      mkdirp(dir);
      fs.writeFileSync(path.join(dir, `${c.id}.svg`), svg);
      c.bild = `img/kandidaten/${c.id}.svg?v=${createHash("sha1").update(svg).digest("hex").slice(0, 8)}`;
    }
    // a revised dish keeps its AI photo only while its photo description is unchanged, otherwise it is painted anew
    if (prev?.bild_fuer && prev.bild_fuer === c.bild_prompt) Object.assign(c, { bild: prev.bild, bild_fuer: prev.bild_fuer });
    out.push(c);
  }
  return [out, notes];
}

const SAFE_ID = /^[\p{L}\p{N}-]{1,80}$/u; // candidate ids are model output and become file names

/** Same framing for every dish, so the photos look like one menu. */
const photo_prompt = (dish: string, warm: boolean) => "Realistic appetizing food photograph, 45-degree angle, one serving on a white "
  + `ceramic plate on a rustic wooden table, soft natural window light, shallow depth of field, high detail${warm ? ", gentle steam rising" : ""}. ${dish}`;

/** One local AI photo (`[images] ai` command, e.g. mflux) of a dish; `variant` 0 = its usual look, more = another take.
 * Returns the new `bild` path, or null when not configured or the generator failed. */
export async function ai_photo(hh: Household, c: Obj, variant = 0): Promise<string | null> {
  const [cmd, ...args] = String(hh.raw.images?.ai ?? "").trim().split(/\s+/).filter(Boolean);
  if (!cmd || !truthy(c.bild_prompt) || !SAFE_ID.test(String(c.id))) return null;
  const rel = `kandidaten/${c.id}.png`, out = path.join(hh.paths.images, rel);
  const seed = String(parseInt(createHash("sha1").update(c.id).digest("hex").slice(0, 6), 16) + variant); // same dish, same photo
  mkdirp(path.dirname(out));
  const tmp = `${out}.neu.png`; // the old photo stays visible until the new one is done
  fs.rmSync(tmp, { force: true });
  try {
    await agent.runner.exec(cmd, [...args, "--seed", seed, "--output", tmp, "--prompt",
      photo_prompt(c.bild_prompt, !truthy(hh.meals.find((m) => m.id === c.slot)?.cold))], { cwd: hh.root, timeoutMs: 5 * 60 * 1000 });
  } catch (e) {
    console.error(e);
    return null;
  }
  if (!fs.existsSync(tmp)) return null;
  fs.renameSync(tmp, out);
  return `img/${rel}?v=${createHash("sha1").update(fs.readFileSync(out)).digest("hex").slice(0, 8)}`;
}

/** New photos for every dish whose photo description changed (new or revised dishes), one at a time, ~15 s each. */
async function ai_photos(hh: Household, roundPath: string, onChange: () => void): Promise<void> {
  if (!String(hh.raw.images?.ai ?? "").trim()) return;
  for (const c of read(roundPath).kandidaten) {
    if (!truthy(c.bild_prompt) || c.bild_fuer === c.bild_prompt) continue;
    const bild = await ai_photo(hh, c);
    if (!bild) continue;
    const cur = read(roundPath);
    // only if the dish was not revised meanwhile
    for (const k of cur.kandidaten) if (k.id === c.id && k.bild_prompt === c.bild_prompt) Object.assign(k, { bild, bild_fuer: c.bild_prompt });
    write(roundPath, cur);
    onChange();
  }
}

/** Fill in missing photos one by one after the round is already visible. */
export function fetch_images_async(hh: Household, roundPath: string, onChange: () => void): Promise<void> {
  const work = async () => {
    const r = read(roundPath);
    for (const c of r.kandidaten) {
      if (truthy(c.bild) || !truthy(c.bild_suche)) continue;
      const credit = await images.fetch_(hh, c.bild_suche, `kandidaten/${c.id}`);
      if (credit) {
        const cur = read(roundPath);
        for (const k of cur.kandidaten) if (k.id === c.id) k.bild = `img/${credit.file}`;
        write(roundPath, cur);
        onChange();
      }
    }
    await ai_photos(hh, roundPath, onChange);
  };
  const t: Promise<void> = work().catch((e) => { console.error(e); }).finally(() => { BACKGROUND.delete(t); });
  BACKGROUND.add(t);
  return t;
}

export async function finish_round(hh: Household, db: Obj, r: Obj, p: string, progress: Progress): Promise<void> {
  progress("prices");
  const pr = await prices.compare(hh, db, r, r.einkauf_iso || iso(today()));
  if (pr) write(path.join(path.dirname(p), path.parse(p).name + "-preise.json"), pr);
  write(p, r);
  progress("images");
  fetch_images_async(hh, p, () => progress("images"));
}

/** Day offset of shopping/prep day relative to the first eating day, as text for the prompt. */
function offset(hh: Household, r: Obj, key: string): string {
  const s = hh.schedule;
  const first = fromIso(r.id);
  const day = key === "einkauf_iso" ? s.shopping_day : s.prep_day;
  const back = mod7(weekday(first) - weekdayIndex(day)) || 7;
  return `tag = -${back}`;
}

const mailbox = (hh: Household, rid: string): Obj => read(path.join(hh.paths.mailbox, `${rid}.json`), {}) || {};

function brief(c: Obj): Obj {
  const b: Obj = {};
  for (const k of ["id", "slot", "titel", "untertitel", "tags", "aktiv", "pitch", "rechnung", "bild_suche"]) b[k] = c[k];
  const f = c.berechnet?.skalierung;
  if (f && !(0.8 <= f && f <= 1.25)) { // the server had to stretch the recipe a lot: the amounts are off
    b.achtung = `rechnung is ${f > 1 ? "too small" : "too big"}: the server had to scale the main part `
      + `×${floatStr(f)}. If you change this dish, fix the amounts so it adds up to the total kcal.`;
  }
  return b;
}

const pick = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.map((k) => [k, o[k]]));

// ---------- actions ----------------------------------------------------------------------------
/** The week's leaflet as the starting point for ideas (empty when `offers.browse` is not configured). */
function browse_section(lf: { text: string; stores: string[] }): string {
  if (!lf.text) return "";
  const names = lf.stores.map((id) => RETAILERS[id] ?? id).join(" + ");
  return `
# This week's leaflet: ${names} (the household shops at these stores only, never more than ${lf.stores.length})
${lf.text}

Cook with the leaflet: EVERY dish is built on a main ingredient from these offers (the meat, fish, cheese or
vegetable the dish is about) and names that offer in \`warum\`. Everything else is bought at the same stores.
An ingredient that is not in the ingredient list goes into \`neue_zutaten\` with the offer's price per kg and store.
`;
}

/** Titles of the dishes suggested in the last few rounds, newest first, so a new round can avoid them. */
function recent_dishes(hh: Household, rounds = 4): string {
  const lines = ids(hh.paths.rounds).reverse().slice(0, rounds).flatMap((rid) =>
    (read(path.join(hh.paths.rounds, `${rid}.json`))?.kandidaten ?? []).map((c: Obj) => `- ${rid} · ${c.slot}: ${c.titel}`));
  return lines.join("\n") || "(none)";
}

export async function new_round(hh: Household, ident: string, progress: Progress): Promise<string> {
  let db = calc.load_ingredients(hh);
  // ident = an open round whose suggestions are thrown away for fresh ones (same dates); empty = the next round
  const p0 = ident ? path.join(hh.paths.rounds, `${ident}.json`) : "";
  const old = ident ? read(p0) : undefined;
  if (ident && !old) throw new Error(`round ${ident} not found`);
  if (old?.status === "geplant") throw new Error(`round ${ident} is already planned`);
  const d = old ?? round_dates(hh);
  progress("offers");
  const lf = await prices.browse_digest(hh, d.einkauf_iso, ident ? mailbox(hh, ident).laeden : []); // stores the household picked
  const deals = await prices.deals_digest(hh, db, d.einkauf_iso, undefined, lf.stores);
  const leaflet = browse_section(lf);
  const n = hh.agent.candidates_per_meal;
  progress("thinking");
  // what the household did on the site for this round still counts for the fresh ideas
  const mb0 = ident ? pick(mailbox(hh, ident), ["wuensche", "idee", "nachrichten"]) : {};
  const wishes = truthy(mb0.wuensche) || truthy(mb0.idee) || truthy(mb0.nachrichten) ? `
# The household's wishes and messages on the site (apply them to every new dish)
${dumps({ wuensche: mb0.wuensche ?? [], idee: mb0.idee ?? "" })}
Latest messages: ${dumps((mb0.nachrichten ?? []).slice(-3))}
` : "";
  const res = await agent.run(hh, agent.household_context(hh, db, deals) + leaflet + wishes + `
# Dishes suggested in the last rounds
${recent_dishes(hh)}

# Task
Propose a new round for ${d.zeitraum} (shopping ${d.einkaufstag}, prep ${d.preptag}).
Give exactly ${n} candidates per slot (${hh.meals.map((m) => m.id).join(", ")}), all clearly different from each
other, respecting every rule, exclusion and blocked category in the feedback log.
Variety: the household finds the suggestions repetitive. Per slot, at most ONE candidate may come from the list
above (only one the feedback log rates 8/10 or better); every other candidate is a dish not on that list. A new
protein, a renamed variant or a different vegetable in the same dish does not make it new: same dish idea =
same dish. Spread the new ones over different cuisines, main ingredients and sauce bases. Apply the proven
principles (browned meat, real sauce, cheese, ...) to new dishes instead of repeating old ones.
Prefer this week's offers where they fit. Write \`nachricht\` as a short intro.
`, agent.ROUND_SCHEMA, hh.root);
  progress("calculating");
  calc.add_ingredients(hh, res.neue_zutaten ?? {});
  db = calc.load_ingredients(hh);
  const [cands, notes] = process_candidates(hh, db, need(res, "kandidaten"), {});
  const r: Obj = {
    id: d.id, titel: d.zeitraum, zeitraum: d.zeitraum, einkaufstag: d.einkaufstag,
    einkauf_iso: d.einkauf_iso, preptag: d.preptag, status: "offen", erstellt: now(),
    nachricht: need(res, "nachricht"), verlauf: [{ zeit: now(), von: "claude", text: res.nachricht }],
    kandidaten: cands, hinweise: notes, ...(lf.stores.length ? { einkauf_laeden: lf.stores } : {}),
  };
  if (old) {
    write(p0, old, path.join(hh.paths.jobs, "backups")); // keeps a copy of the discarded suggestions
    const mp = path.join(hh.paths.mailbox, `${ident}.json`), mb = mailbox(hh, ident);
    // picks and thumbs point at the old dishes; wishes and messages still apply
    if (fs.existsSync(mp)) { delete mb.auswahl; delete mb.reaktionen; write(mp, mb) }
  }
  await finish_round(hh, db, r, path.join(hh.paths.rounds, `${d.id}.json`), progress);
  return res.nachricht;
}

export async function revise(hh: Household, rid: string, progress: Progress): Promise<string> {
  let db = calc.load_ingredients(hh);
  const p = path.join(hh.paths.rounds, `${rid}.json`);
  const r = read(p);
  if (!r) throw new Error(`round ${rid} not found`);
  const mb = mailbox(hh, rid);
  progress("offers");
  // a revision stays with the round's stores, otherwise one dish could need a third store
  const lf = await prices.browse_digest(hh, r.einkauf_iso || iso(today()), mb.laeden?.length ? mb.laeden : r.einkauf_laeden ?? []);
  const deals = await prices.deals_digest(hh, db, r.einkauf_iso || iso(today()), undefined, lf.stores);
  const leaflet = browse_section(lf);
  progress("thinking");
  const res = await agent.run(hh, agent.household_context(hh, db, deals) + leaflet + `
# Current round
${dumps(r.kandidaten.map(brief))}

# The household's reactions (mailbox)
${dumps(pick(mb, ["auswahl", "reaktionen", "wuensche", "idee"]))}
Latest messages: ${dumps((mb.nachrichten ?? []).slice(-3))}

# Task
Revise the round. Return the full list again, ${hh.agent.candidates_per_meal} per slot:
- thumbs up (daumen 1) without a note → {"id": "...", "slot": "...", "keep": true}
- a note on a dish → same id, change the recipe accordingly, explain in \`antwort\`
- thumbs down → replace with a new dish (new id) that avoids the reason
- \`wuensche\` (e.g. faster, cheaper) always apply to the whole round, also when a message asks for something
  else: every dish you return in full must satisfy them; say in \`antwort\` what you changed for them.
  \`idee\` becomes its own candidate if it is a dish; otherwise it is feedback or an instruction (e.g. about one slot):
  follow it like a message and say in \`nachricht\` how you applied it
- if a wish breaks an exclusion or blocked category, do not do it; say so in one sentence in \`nachricht\`
  and offer the closest safe alternative
- keep the currently selected dishes unless the household asked to change them
`, agent.ROUND_SCHEMA, hh.root);
  progress("calculating");
  calc.add_ingredients(hh, res.neue_zutaten ?? {});
  db = calc.load_ingredients(hh);
  const [cands, notes] = process_candidates(hh, db, need(res, "kandidaten"), Object.fromEntries(r.kandidaten.map((c: Obj) => [c.id, c])));
  // a dish Claude forgot to return is kept, unless the household gave it a thumbs down
  const reac = mb.reaktionen || {}, idsNow = new Set(cands.map((c) => c.id));
  for (const c of r.kandidaten) {
    const slotFull = cands.filter((k) => k.slot === c.slot).length >= hh.agent.candidates_per_meal;
    if (!idsNow.has(c.id) && !slotFull && (reac[c.id] || {}).daumen !== -1) cands.push({ ...c, neu: false });
  }
  r.kandidaten = cands; r.hinweise = notes; r.nachricht = res.nachricht;
  if (lf.stores.length) r.einkauf_laeden = lf.stores;
  (r.verlauf ??= []).push({ zeit: now(), von: "claude", text: res.nachricht });
  await finish_round(hh, db, r, p, progress);
  return res.nachricht;
}

/** How the prep-day timeline is ordered (plan and "plan the prep day again"). */
const PREP_ORDER = `Two phases, in this order. \`phase\` "vorbereiten" first: ALL cutting, weighing and mixing for every dish
before anything is heated (mise en place); preheating the oven may be its first step. Everything that goes into the
pan, pot or tray in the same cooking step is collected in ONE bowl with a name (\`schuessel\`, e.g. "Gemüse-Schüssel
Stroganoff", never a number); a sauce or creme is stirred together completely in the bowl it is used from. Then
\`phase\` "kochen": one dish after the other; each step names the bowl it empties (\`schuessel\`) and repeats the amounts,
no more cutting. \`neben\` is only for hands-off time (oven, covered simmering) — never two active hob, stirring or
mixing steps at once.`;

/** Plan the prep day of a planned week again: only the timeline; recipes, shopping list and boxes stay. */
export async function replan_prep(hh: Household, rid: string, progress: Progress): Promise<string> {
  const db = calc.load_ingredients(hh);
  const wp = path.join(hh.paths.weeks, `${rid}.json`), w = read(wp);
  if (!w) throw new Error(`week ${rid} not found`);
  progress("thinking");
  const res = await agent.run(hh, agent.household_context(hh, db, "(not needed)") + `
# The week's recipes (amounts for all portions)
${dumps((w.rezepte as Obj[]).map((x) => pick(x, ["id", "titel", "zutaten", "schritte", "kipppunkt"])))}
Extras: ${dumps((w.extras ?? []).map((x: Obj) => pick(x, ["id", "titel", "zutaten", "schritte"])))}
Equipment: ${dumps(w.geraete ?? [])}
The current timeline (do better): ${dumps(w.prep ?? [])}

# Task
Write the prep-day timeline for ${w.preptag} again, for both dishes together, offsets from 0:00. Each step is ONE
action: \`titel\` 2–4 words, \`text\` at most ~20 words incl. the amounts (produce in grams), \`gericht\` = the recipe or
extra id. Timers in minutes, at most 3 steps \`wichtig\`. ${PREP_ORDER}
Keep every amount and technique from the recipes; change only the order and grouping.
`, agent.PREP_SCHEMA, hh.root);
  const prep = need(res, "prep");
  if (!Array.isArray(prep) || !prep.length) throw new Error("Claude returned no timeline");
  w.prep = prep;
  const backups = path.join(hh.paths.jobs, "backups");
  write(wp, w, backups);
  const md = path.join(hh.paths.plans, `woche-${rid}.md`);
  if (fs.existsSync(md)) {
    mkdirp(backups);
    fs.copyFileSync(md, path.join(backups, `${path.parse(md).name}.${stamp()}.md`));
  }
  fs.writeFileSync(md, week_markdown(hh, w), "utf-8");
  const bowls = new Set(prep.map((x: Obj) => x.schuessel).filter(Boolean)).size;
  return `${w.preptag}: ${prep.length} ${hh.language === "de" ? "Schritte" : "steps"}, ${bowls} ${hh.language === "de" ? "Schüsseln" : "bowls"}`;
}

/** Improve one dish of an open round (mailbox \`optimieren\`: {id, text}); every other dish stays exactly as it is. */
export async function optimize(hh: Household, rid: string, progress: Progress): Promise<string> {
  let db = calc.load_ingredients(hh);
  const p = path.join(hh.paths.rounds, `${rid}.json`);
  const r = read(p);
  if (!r) throw new Error(`round ${rid} not found`);
  if (r.status === "geplant") throw new Error(`round ${rid} is already planned`);
  const mp = path.join(hh.paths.mailbox, `${rid}.json`), mb = mailbox(hh, rid), want = mb.optimieren ?? {};
  const c = r.kandidaten.find((k: Obj) => k.id === want.id);
  if (!c) throw new Error("pick the dish to improve first");
  progress("offers");
  const lf = await prices.browse_digest(hh, r.einkauf_iso || iso(today()), mb.laeden?.length ? mb.laeden : r.einkauf_laeden ?? []);
  const deals = await prices.deals_digest(hh, db, r.einkauf_iso || iso(today()), undefined, lf.stores);
  progress("thinking");
  const res = await agent.run(hh, agent.household_context(hh, db, deals) + browse_section(lf) + `
# The dish to improve
${dumps({ ...brief(c), pitch: c.pitch, risiko: c.risiko, teller: c.teller, bild_prompt: c.bild_prompt })}

# What the household wants for this dish
${dumps(String(want.text ?? "").slice(0, 600))}
Standing wishes for the round: ${dumps(mb.wuensche ?? [])}

# The other dishes of the round (leave them alone, do not copy them)
${r.kandidaten.filter((k: Obj) => k.id !== c.id).map((k: Obj) => `- ${k.slot}: ${k.titel}`).join("\n")}

# Task
Improve ONLY this dish. Return exactly one candidate: id "${c.id}", slot "${c.slot}", the full dish (never \`keep\`).
Keep what already works about it and apply the household's request; stay within every rule, exclusion, blocked
category and the slot's constraints. Recalculate \`rechnung\` for all portions, and rewrite \`pitch\`, \`teller\` and
\`bild_prompt\` for the new version. \`antwort\`: 1–2 sentences on what you changed. \`nachricht\`: one sentence.
`, agent.ROUND_SCHEMA, hh.root);
  progress("calculating");
  calc.add_ingredients(hh, res.neue_zutaten ?? {});
  db = calc.load_ingredients(hh);
  const got = (need(res, "kandidaten") as Obj[]).filter((k) => k.id === c.id && k.slot === c.slot && !truthy(k.keep)).slice(0, 1);
  const [cands, notes] = process_candidates(hh, db, got, { [c.id]: c });
  if (!cands.length) throw new Error(notes[0] ?? "Claude did not return the improved dish");
  r.kandidaten = r.kandidaten.map((k: Obj) => (k.id === c.id ? cands[0] : k));
  r.nachricht = res.nachricht ?? r.nachricht;
  (r.verlauf ??= []).push({ zeit: now(), von: "claude", text: `${c.titel}: ${cands[0].antwort || res.nachricht || ""}`.trim() });
  if (fs.existsSync(mp)) { // the request is done: it must not be applied again by the next revision
    delete mb.optimieren;
    if (mb.reaktionen?.[c.id]) delete mb.reaktionen[c.id].notiz;
    write(mp, mb);
  }
  await finish_round(hh, db, r, p, progress);
  return `${cands[0].titel}: ${cands[0].antwort || res.nachricht || ""}`.trim();
}

export async function plan(hh: Household, rid: string, progress: Progress): Promise<string> {
  const db = calc.load_ingredients(hh);
  const p = path.join(hh.paths.rounds, `${rid}.json`);
  const r = read(p);
  if (!r) throw new Error(`round ${rid} not found`);
  const mb = mailbox(hh, rid);
  const chosen: Obj[] = hh.meals.map((m) => r.kandidaten.find((c: Obj) => c.id === (mb.auswahl ?? {})[m.id]));
  if (chosen.includes(undefined as any)) throw new Error("select one dish per meal first");
  progress("thinking");
  const detail = chosen.map((c) => ({
    ...brief(c), mengen_gesamt_g: c.berechnet.mengen, pro_portion_g: c.rechnung.pro_portion,
    warum: c.warum, risiko: c.risiko, makros: c.makros,
  }));
  const res = await agent.run(hh, agent.household_context(hh, db, "(not needed)") + `
# Chosen dishes (amounts already calculated — use exactly these totals in \`zutaten\`)
${dumps(detail)}
Notes from the household: ${dumps(pick(mb, ["reaktionen", "idee"]))}

# Task
Write the cooking plan for prep day ${r.preptag} The household reads it on a phone while cooking:
short, scannable, one action per line, no prose.

Per recipe:
- \`zutaten\`: ingredient groups with amounts, incl. spices. Fresh produce (vegetables, fruit, herbs sold loose or
  by size) is ALWAYS in grams rounded to 50 g with the approximate count in brackets: "1,2 kg Salatgurken (ca. 3–4 Stück)",
  "500 g Zwiebeln (ca. 4)". Never a bare piece count for produce. Packaged goods stay whole packs
  ("2 Packungen Hack à 1 kg"), eggs are pieces ("3 Eier"), spices and oil in spoons. Everything else grams rounded to 10 g.
- \`schritte\`: how to cook this dish on its own, 3–6 steps, one action each, amounts inside (produce in grams, as above).
- \`kipppunkt\`: the one make-or-break step. \`portion\` per person id (${hh.persons.map((q) => q.id).join(", ")}): what goes into one box.
- \`zusammenbau_wann\`, \`zusammenbau_min\`, \`packen\` (container → exact content, max 3 rows), \`essen\` (2–3 tiny steps).
A side eaten with more than one dish (e.g. a pickled salad) goes ONCE into \`extras\`, with the amounts for all
portions and its own steps. Never repeat it inside each recipe's \`zutaten\`.

\`prep\`: one combined timeline for everything, offsets from 0:00, about 10–16 steps. Each step is ONE action:
\`titel\` 2–4 words ("Bällchen formen"), \`text\` at most ~20 words incl. the amounts (produce in grams, as above), \`gericht\` = the recipe or
extra id. Timers in minutes, at most 3 steps \`wichtig\`. ${PREP_ORDER}
\`ersatz\`: for every main ingredient (meat, fish, cheese, the main vegetable) the substitute to buy if it is sold out:
in the same store${r.einkauf_laeden?.length ? ` (${r.einkauf_laeden.map((id: string) => RETAILERS[id] ?? id).join(" or ")})` : ""}, same amount, similar macros and price, ready-to-cook, nothing excluded
or blocked; \`aenderung\` says what changes when cooking ("Pute 2 Min kürzer braten"), or "nichts".
\`zusatz_einkauf\`: everything the recipes need that is neither in the calculated shopping list nor in the pantry
file (vinegar, fresh herbs …), with a rough price; \`menge\` follows the produce rule too ("200 g Basilikum"). \`vorrat\`: only items the pantry file lists.
Also: \`geraete\` = equipment incl. containers, ONLY items from the kitchen equipment list (plus the household's own
containers), each with what it is used for ("Fettpfanne (2 cm Rand): Bällchen, Sauce erst nach dem Backen dazu"). Then: things not to buy, 3–4 "why" cards, 3–4 concrete feedback questions.
\`vorbereitung\`: every task OUTSIDE the prep timeline, as day offsets from the first eating day (shopping day is
${offset(hh, r, "einkauf_iso")}, prep day is ${offset(hh, r, "prep_iso")}): storing meat after shopping, what to set out
or preheat before the prep starts, and freezer reminders (e.g. "evening of day 4: move the boxes for day 5 into the fridge"). No other mid-week tasks.
\`behaelter\`: what goes into which container on prep day, with counts and the split per person.
`, agent.PLAN_SCHEMA, hh.root);
  progress("calculating");
  const week = build_week(hh, db, r, chosen, res);
  const backups = path.join(hh.paths.jobs, "backups");
  write(path.join(hh.paths.weeks, `${rid}.json`), week, backups);
  const md = path.join(hh.paths.plans, `woche-${rid}.md`);
  if (fs.existsSync(md)) {
    mkdirp(backups);
    fs.copyFileSync(md, path.join(backups, `${path.parse(md).name}.${stamp()}.md`));
  }
  fs.writeFileSync(md, week_markdown(hh, week), "utf-8");
  const [status, note] = hh.language === "de" ? ["offen", "neu im Plan"] : ["open", "new in plan"];
  append_ratings(hh, chosen.map((c) => [r.zeitraum, c.titel, status, note]));
  r.status = "geplant";
  (r.verlauf ??= []).push({
    zeit: now(), von: "claude",
    text: `Plan steht: ${chosen.map((c) => c.titel).join(" + ")} · ${fmtFixed(week.budget.summe, 2)} ${hh.currency}`,
  });
  write(p, r);
  return `${week.titel} — ${fmtFixed(week.budget.summe, 2)} ${hh.currency}`;
}

const AISLES: Record<string, string> = { chilled: "Kühlung", produce: "Obst & Gemüse", dry: "Konserven & Trocken", frozen: "Tiefkühl", other: "Sonstiges", pantry: "Erst zu Hause nachsehen" };
const AISLES_EN: Record<string, string> = { chilled: "Chilled", produce: "Produce", dry: "Dry goods", frozen: "Frozen", other: "Other", pantry: "Check at home first" };

/** "400 g", "1 kg", "1,5 kg" */
const packText = (g: number, de: boolean) => g >= 1000 ? `${String(pyRound(g / 1000, 2)).replace(".", de ? "," : ".")} kg` : `${pyRound(g)} g`;

/** Rebuild the shopping list of a planned week from the current offers, without Claude: real packs, where each
 * offer was found, one or two stores. Recipes, substitutes and extras stay as planned. */
export async function refresh_shopping(hh: Household, rid: string, progress: Progress): Promise<string> {
  const db = calc.load_ingredients(hh);
  const r = read(path.join(hh.paths.rounds, `${rid}.json`)), wp = path.join(hh.paths.weeks, `${rid}.json`), w = read(wp);
  if (!r || !w) throw new Error(`week ${rid} not found`);
  const chosen: Obj[] = w.rezepte.map((x: Obj) => r.kandidaten.find((c: Obj) => c.id === x.id)).filter(Boolean);
  progress("prices");
  const pr = await prices.compare(hh, db, r, r.einkauf_iso || iso(today()));
  if (pr) write(path.join(hh.paths.rounds, `${rid}-preise.json`), pr);
  // keep the substitutes the plan named, matched by ingredient name
  const old: Obj[] = w.einkauf.flatMap((g: Obj) => g.items), alt: Obj = {};
  for (const c of chosen) for (const l of c.berechnet.einkaufsliste) {
    const it = old.find((i) => i.kurz === l.name || String(i.name).startsWith(`${l.name} (`));
    if (it?.ersatz) alt[l.zutat] = { kaufen: it.ersatz, aenderung: it.ersatz_aenderung ?? "" };
  }
  const { groups, storePlan, one, two } = shopping(hh, db, r, chosen, alt);
  const extras = w.einkauf.filter((g: Obj) => g.bereich === (hh.language === "de" ? "Dazu kaufen" : "Also buy"));
  const named = (p: Obj) => ({ laeden: (p.stores as string[]).map((s) => pr?.laeden?.[s] ?? s), summe: p.total });
  const stores = (storePlan.stores as string[]).map((s) => pr?.laeden?.[s] ?? s);
  Object.assign(w, {
    einkauf: [...[...groups].map(([k, v]) => ({ bereich: k, items: v })), ...extras],
    einkaufstag: `${r.einkaufstag} · ${stores.join(" + ") || "–"}`,
    budget: { ...w.budget, summe: pyRound(storePlan.total + pySum(extras.flatMap((g: Obj) => g.items).map((i: Obj) => i.preis * i.anz)), 2) },
    ...(one && two ? { laeden_vergleich: { allein: named(one), zwei: named(two), grenze: hh.offers.second_store_min_saving } } : {}),
  });
  const backups = path.join(hh.paths.jobs, "backups");
  write(wp, w, backups);
  const md = path.join(hh.paths.plans, `woche-${rid}.md`);
  if (fs.existsSync(md)) {
    mkdirp(backups);
    fs.copyFileSync(md, path.join(backups, `${path.parse(md).name}.${stamp()}.md`));
  }
  fs.writeFileSync(md, week_markdown(hh, w), "utf-8");
  return `${w.einkaufstag} — ${fmtFixed(w.budget.summe, 2)} ${hh.currency}`;
}

/** The shopping list for the chosen dishes: rows by aisle with real offer packs, where each offer was found,
 * substitutes (`alt`, by ingredient key) and what one store vs. the best two stores cost. */
function shopping(hh: Household, db: Obj, r: Obj, chosen: Obj[], alt: Obj): Obj {
  const pr = read(path.join(hh.paths.rounds, `${r.id}-preise.json`)) ?? null;
  const items = new Map<string, Obj>();
  for (const c of chosen) {
    for (const l of c.berechnet.einkaufsliste) {
      const it = items.get(l.zutat) ?? { ...l, g: 0 };
      items.set(l.zutat, it);
      it.g += l.g;
    }
  }
  const storePlan = prices.plan_stores(pr, [...items.values()], hh.offers.second_store_min_saving);
  // for the shopping view: what one store costs and what the best second store would save
  const one = pr ? prices.plan_stores(pr, [...items.values()], Infinity) : null, two = pr ? prices.plan_stores(pr, [...items.values()], 0) : null;
  const names = hh.language === "de" ? AISLES : AISLES_EN, de = hh.language === "de";
  const groups = new Map<string, Obj[]>();
  for (const row of storePlan.rows as Obj[]) {
    const a = db[row.zutat]?.aisle || row.aisle || "other";
    const sg = db[row.zutat]?.stueck_g;
    const pcs = a === "produce" && sg ? ` · ca. ${Math.max(1, pyRound(row.g / sg))} ${hh.language === "de" ? "Stück" : "pcs"}` : "";
    const key = names[a] ?? a;
    if (!groups.has(key)) groups.set(key, []);
    // on offer at the chosen store: buy the offer's real pack, up to 3 % short is fine. An offer at exactly the
    // planned price counts too; a dearer one (premium brand, tiny pack, another rice) does not
    const fb = row.laden_plan ? pr?.zutaten?.[row.zutat]?.angebote?.[row.laden_plan] : undefined;
    const o = row.angebot ?? (fb && fb.eur_kg <= Number(row.eur_kg) ? fb : undefined);
    const offerPack = o?.preis && o?.eur_kg ? pyRound((o.preis / o.eur_kg) * 1000) : 0;
    if (offerPack) {
      let n = Math.max(1, Math.ceil(row.g / offerPack));
      if (n > 1 && (n - 1) * offerPack >= row.g * 0.97) n--;
      storePlan.total += n * o.preis - row.eur;
      Object.assign(row, { packungen: n, eur: pyRound(n * o.preis, 2) });
    }
    const normal = prices.normal_eur_kg(db[row.zutat]);
    groups.get(key)!.push({
      name: `${row.name} (${fmtThousands(row.g)} g)`.replaceAll(",", de ? "." : ",") + pcs, anz: row.packungen,
      preis: pyRound(row.eur / row.packungen, 2), a: truthy(o),
      laden: pr ? pr.laeden?.[row.laden_plan] ?? "" : row.laden ?? "",
      ...(row.pack_g || offerPack ? {
        // eggs and the like in pieces, everything else by weight; the name without its "(Stück ≈ 60 g)" note
        pack: sg && a !== "produce" ? `${Math.max(1, pyRound((offerPack || row.pack_g) / sg))} ${de ? "Stück" : "pcs"}` : packText(offerPack || row.pack_g, de),
        kurz: String(row.name).replace(/\s*\([^)]*\)\s*$/, ""),
      } : {}),
      ...(o ? { angebot: { laden: o.laden, produkt: o.produkt, preis: o.preis, eur_kg: o.eur_kg, bis: o.bis ?? null,
        ...(normal ? { vs_normal: Math.round((o.eur_kg / normal - 1) * 100), normal_eur_kg: normal } : {}) } } : {}),
      ...(alt[row.zutat]?.kaufen ? { ersatz: String(alt[row.zutat].kaufen), ersatz_aenderung: String(alt[row.zutat].aenderung ?? "") } : {}),
    });
  }
  return { groups, storePlan, one, two, pr, items };
}

export function build_week(hh: Household, db: Obj, r: Obj, chosen: Obj[], res: Obj): Obj {
  const alt: Obj = Object.fromEntries((Array.isArray(res.ersatz) ? res.ersatz : []).map((e: Obj) => [e.zutat, e]));
  const { groups, storePlan, one, two, pr, items } = shopping(hh, db, r, chosen, alt);
  const byId: Obj = Object.fromEntries(need(res, "rezepte").map((x: Obj) => [x.id, x]));
  const rezepte: Obj[] = [];
  chosen.forEach((c, i) => {
    const meal = hh.meals[i];
    if (!meal) return; // zip() stops at the shorter list
    const x: Obj = Object.hasOwn(byId, c.id) ? byId[c.id] : {};
    const rez: Obj = {
      id: c.id, slot: meal.label ?? meal.id, titel: c.titel, kurz: x.kurz ?? "", untertitel: c.untertitel ?? "",
      bild: c.bild ?? "", tags: c.tags ?? [], aktiv: c.aktiv ?? 20, portionen: hh.days * hh.persons.length,
      makros: c.makros, zutaten: x.zutaten ?? [], schritte: x.schritte ?? [],
      kipppunkt: x.kipppunkt ?? c.risiko ?? "",
      anrichten: x.anrichten ?? [], portion: x.portion ?? {}, reihenfolge: x.reihenfolge ?? false,
    };
    if (truthy(x.rechner_label)) rez.rechner = { label: x.rechner_label, ...c.berechnet.anteil };
    if (truthy(x.zusammenbau_wann) || truthy(x.packen)) {
      rez.zusammenbau = {
        wann: x.zusammenbau_wann ?? "", min: x.zusammenbau_min ?? null,
        packen_titel: x.packen_titel ?? "", packen: x.packen ?? [], essen: x.essen ?? [],
      };
    }
    rezepte.push(rez);
  });
  const stores: string[] = (storePlan.stores as string[]).map((s) => pr?.laeden?.[s] ?? s);
  const einkauf: Obj[] = [...groups].map(([k, v]) => ({ bereich: k, items: v }));
  const extraItems: Obj[] = (res.zusatz_einkauf ?? []).map((z: Obj) => ({
    name: `${z.name} (${z.menge})`, anz: 1, preis: pyRound(Number(z.preis), 2), a: false, laden: "",
  }));
  if (extraItems.length) einkauf.push({ bereich: hh.language === "de" ? "Dazu kaufen" : "Also buy", items: extraItems });
  const summe = pyRound(storePlan.total + pySum(extraItems.map((i) => i.preis)), 2);
  const named = (p: Obj) => ({ laeden: (p.stores as string[]).map((s) => pr?.laeden?.[s] ?? s), summe: p.total });
  const f0 = hh.fixed_meals[0];
  return {
    id: r.id, titel: need(res, "titel"), zeitraum: r.zeitraum,
    einkaufstag: `${r.einkaufstag} · ${stores.join(" + ") || "–"}`,
    preptag: `${r.preptag} · ~${pySum(rezepte.map((x) => x.aktiv)) + 10} Min`,
    budget: { summe, limit: hh.budget },
    ...(one && two ? { laeden_vergleich: { allein: named(one), zwei: named(two), grenze: hh.offers.second_store_min_saving } } : {}),
    hero: rezepte.find((x) => truthy(x.bild))?.bild ?? "",
    personen: Object.fromEntries(hh.persons.map((p) => [p.id, { label: p.label ?? p.id, wer: p.name ?? "", ziel: p.kcal }])),
    fruehstueck: f0 ? { name: f0.name, text: f0.text ?? "", kcal: f0.kcal ?? 0, p: f0.protein ?? 0, kh: f0.carbs ?? 0 } : null,
    rezepte, extras: res.extras ?? [],
    einkauf,
    vorrat: [...(res.vorrat ?? []), ...[...items.values()].filter((i) => i.laden === "Vorrat").map((i) => i.name)],
    nicht_kaufen: res.nicht_kaufen ?? [], geraete: need(res, "geraete"), prep: need(res, "prep"),
    warum: need(res, "warum"), feedback: need(res, "feedback"), lagerung: res.lagerung ?? "",
    behaelter: res.behaelter ?? [],
    vorbereitung: (res.vorbereitung ?? []).map((v: Obj) => ({
      datum: iso(addDays(fromIso(r.id), need(v, "tag"))), wann: v.wann ?? "", text: need(v, "text"),
    })),
    erstellt: now(),
  };
}

export async function feedback(hh: Household, wid: string, progress: Progress): Promise<string> {
  const db = calc.load_ingredients(hh);
  const week = read(path.join(hh.paths.weeks, `${wid}.json`));
  if (!week) throw new Error(`week ${wid} not found`);
  const fb = mailbox(hh, `feedback-${wid}`);
  progress("thinking");
  const summary = {
    ...pick(week, ["zeitraum", "titel"]),
    rezepte: week.rezepte.map((x: Obj) => pick(x, ["id", "titel", "untertitel"])), fragen: week.feedback,
  };
  const res = await agent.run(hh, agent.household_context(hh, db, "(not needed)") + `
# The week that was cooked
${dumps(summary)}

# The household's feedback
Structure: gerichte[dish id][person id] = {note 1–10, tags (quick reactions), wieder (cook again?), kommentar};
fakten = actual prep minutes, receipt total, hunger between meals, portion size; antworten = answers to the questions.
Persons: ${hh.persons.map((p) => `${p.id} = ${p.label ?? p.id}`).join(", ")}
${dumps(fb)}

# Task
Turn this into log entries: one rating row per dish. \`note\` shows every person's score, e.g. "8/10 (Alex) · 6/10 (Sam)";
\`kommentar\` condenses tags, cook-again and comments in their words. Add one extra row with gericht "Woche" for the
facts (prep time vs. plan, spend vs. budget, hunger, portion size) if any were given.
Negative tags like "too dry", "mushy", "not filling", "not tolerated" are strong signals.
If something failed, derive the CATEGORY to block (not the single recipe) and/or a general rule — only if the
feedback really supports it, and never duplicate existing entries. Then answer the household in 2–4 sentences.
`, agent.FEEDBACK_SCHEMA, hh.root);
  progress("calculating");
  append_ratings(hh, need(res, "bewertungen").map((b: Obj) => [week.zeitraum, need(b, "gericht"), need(b, "note"), need(b, "kommentar")]));
  append_bullets(hh, "gesperrt|blocked", res.gesperrt ?? [], "## Blocked — never suggest again");
  append_bullets(hh, "regeln|rules", res.regeln ?? [], "## Rules");
  week.feedback_antwort = need(res, "antwort");
  week.feedback_ergebnis = { ...Object.fromEntries(["bewertungen", "gesperrt", "regeln"].map((k) => [k, res[k] ?? []])), zeit: now() };
  write(path.join(hh.paths.weeks, `${wid}.json`), week);
  return res.antwort;
}

// ---------- feedback.md editing (append-only) -------------------------------------------------
const sections = (text: string): [number, string][] => [...text.matchAll(/^#{2,3} (.+)$/gm)].map((m) => [m.index!, m[1]]);

export function append_ratings(hh: Household, rows: (string | number)[][]): void {
  const f = hh.paths.feedback;
  const text = fs.existsSync(f) ? readText(f) : "";
  let add = rows.map(([w, d, n, c]) => `| ${w} | ${d} | **${n}** | ${c} |\n`).join("");
  const secs = sections(text);
  for (let i = 0; i < secs.length; i++) {
    const [pos, title] = secs[i];
    if (/bewertung|rating/i.test(title)) {
      const end = i + 1 < secs.length ? secs[i + 1][0] : text.length;
      const body = text.slice(pos, end);
      let last: number | null = null;
      for (const m of body.matchAll(/^\|.*\|[ \t]*$\n?/gm)) last = m.index! + m[0].length;
      if (last !== null) {
        const insert = pos + last;
        if (!text.slice(0, insert).endsWith("\n")) add = "\n" + add;
        fs.writeFileSync(f, text.slice(0, insert) + add + text.slice(insert), "utf-8");
        return;
      }
    }
  }
  fs.writeFileSync(f, text.trimEnd() + "\n\n## Ratings\n\n| Week | Dish | Score | Comment |\n|---|---|---|---|\n" + add, "utf-8");
}

export function append_bullets(hh: Household, headingRe: string, bullets: string[], fallbackHeading: string): void {
  if (!bullets.length) return;
  const f = hh.paths.feedback;
  const text = fs.existsSync(f) ? readText(f) : "";
  const stampDay = dmy(today());
  const add = bullets.map((b) => `- ${b} *(added ${stampDay})*\n`).join("");
  const secs = sections(text);
  for (let i = 0; i < secs.length; i++) {
    const [pos, title] = secs[i];
    if (new RegExp(headingRe, "i").test(title)) {
      const end = i + 1 < secs.length ? secs[i + 1][0] : text.length;
      const insert = pos + text.slice(pos, end).trimEnd().length + 1;
      fs.writeFileSync(f, text.slice(0, insert) + add + text.slice(insert), "utf-8");
      return;
    }
  }
  fs.writeFileSync(f, text.trimEnd() + `\n\n${fallbackHeading}\n\n` + add, "utf-8");
}

export const ACTIONS: Record<string, (hh: Household, ident: string, progress: Progress) => Promise<string>> = {
  neue_runde: new_round, ueberarbeiten: revise, plan_erstellen: plan, feedback_uebernehmen: feedback, optimieren: optimize,
  einkauf_aktualisieren: refresh_shopping, ablauf_neu: replan_prep,
};
