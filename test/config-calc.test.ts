import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import * as actions from "../src/actions.ts";
import * as calc from "../src/calc.ts";
import { cmd_init } from "../src/commands.ts";
import * as config from "../src/config.ts";
import { Fatal } from "../src/py.ts";
import { FX, copyDir, fixClock, fixture, sameJson, snapshot, tmpDir } from "./helpers.ts";
import fs from "node:fs";

function logs<T>(fn: () => T): { out: string; result?: T; error?: unknown } {
  const orig = console.log;
  let out = "";
  console.log = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  try { const result = fn(); return { out, result }; } catch (error) { return { out, error }; } finally { console.log = orig; }
}

const households: Record<string, string> = {};
test("init creates the same folder (same files, same bytes) and refuses to overwrite", () => {
  const g = fixture("init");
  for (const lang of ["en", "de"]) {
    const d = path.join(tmpDir(), "kitchen");
    const r = logs(() => cmd_init([d, "--lang", lang]));
    assert.equal(r.out.replaceAll(d, "<dir>"), g[lang].stdout.replace("mealprep serve", "mealprep-studio serve"));
    assert.deepStrictEqual(snapshot(d), g[lang].tree);
    const again = logs(() => cmd_init([d, "--lang", lang]));
    assert.ok(again.error instanceof Fatal);
    assert.equal((again.error as Error).message.replaceAll(d, "<dir>"), g[lang].again);
    households[lang] = d;
  }
  // default language is en, an unknown one is a clean error, existing files are never overwritten
  const d = path.join(tmpDir(), "k");
  logs(() => cmd_init([d]));
  assert.deepStrictEqual(snapshot(d), g.en.tree);
  assert.ok(logs(() => cmd_init([path.join(tmpDir(), "x"), "--lang", "fr"])).error instanceof Fatal);
  const e = tmpDir();
  fs.writeFileSync(path.join(e, "profile.md"), "mine");
  logs(() => cmd_init([e]));
  assert.equal(fs.readFileSync(path.join(e, "profile.md"), "utf-8"), "mine");
});

test("household config, merged ingredient DB and errors match", () => {
  const g = fixture("config");
  const custom = tmpDir();
  copyDir(path.join(FX, "household-custom"), custom);
  const dirs: Record<string, string> = { en: households.en, de: households.de, custom };
  for (const [name, d] of Object.entries(dirs)) {
    const hh = config.load(d);
    const e = g[name];
    sameJson(hh.public(), e.public, name + " public");
    for (const k of ["name", "language", "days", "freeze_days", "schedule", "budget", "currency", "offers", "agent", "server", "exclusions", "fixed_meals"] as const) {
      sameJson((hh as any)[k], e[k], `${name}.${k}`);
    }
    sameJson(Object.fromEntries(Object.entries(hh.paths).map(([k, v]) => [k, path.relative(hh.root, v)])), e.paths, name + " paths");
    const dirList: string[] = [];
    const walk = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).forEach((x) => { if (x.isDirectory()) { dirList.push(path.relative(d, path.join(dir, x.name))); walk(path.join(dir, x.name)); } });
    walk(d);
    assert.deepStrictEqual(dirList.sort(), e.dirs, name + " created folders");
    sameJson(Object.fromEntries(hh.meals.map((m) => [m.id, Object.fromEntries(hh.persons.map((p) => [p.id, hh.meal_target(m.id, p.id)]))])), e.targets, name + " targets");
    sameJson(calc.load_ingredients(hh), e.ingredients, name + " ingredients");
  }
  const empty = tmpDir();
  const errMsg = (fn: () => unknown, dir: string) => { try { fn(); } catch (e: any) { return e.message.replaceAll(fs.realpathSync(dir), "<dir>"); } };
  assert.equal(errMsg(() => config.load(empty), empty), g.errors.missing.replace("mealprep init", "mealprep-studio init"));
  for (const [name, content] of Object.entries({ nomeals: 'name="x"\n[[persons]]\nid="a"\nkcal=1\n', nopersons: '[[meals]]\nid="a"\nshare=1\n' })) {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, "household.toml"), content);
    assert.equal(errMsg(() => config.load(d), d), g.errors[name]);
  }
});

test("calculator: macros, scaling, shopping rows, costs, errors, exclusions, add_ingredients", () => {
  const g = fixture("calc");
  const hh = config.load(households.en);
  const db = calc.load_ingredients(hh);
  const cands = [
    { id: "t-ok", slot: "lunch", titel: "Hähnchen-Reis-Bowl", untertitel: "x", rechnung: { slot: "lunch", haupt: { haehnchenbrust: 1500, minigurken: 800, tomaten: 500 }, pro_portion: { reis: 60 } } },
    { id: "t-scale-up", slot: "dinner", rechnung: { slot: "dinner", haupt: { haehnchenbrust: 700, kartoffeln: 800 } } },
    { id: "t-scale-down", slot: "dinner", rechnung: { slot: "dinner", haupt: { hack_gemischt: 3000, reis: 1500 }, pro_portion: { olivenoel: 10, senf: 5 } } },
    { id: "t-pantry", slot: "lunch", rechnung: { slot: "lunch", haupt: { eisberg: 1000, ei: 600, hokkaido: 500, zucchini: 700, kraeuter: 17 }, pro_portion: { olivenoel: 15 } } },
    { id: "t-tiny", slot: "lunch", rechnung: { slot: "lunch", haupt: { kraeuter: 2 } } },
  ];
  sameJson(cands.map((c) => calc.calculate(hh, db, c)), g.calculated);
  const errors = [
    { id: "e1", slot: "lunch", rechnung: { slot: "lunch", haupt: { unobtainium: 100 } } },
    { id: "e2", slot: "lunch", rechnung: { slot: "lunch", haupt: {} } },
    { id: "e3", slot: "lunch", rechnung: { slot: "lunch", haupt: { haehnchenbrust: 100 }, pro_portion: { nope: 5 } } },
  ].map((c) => { try { calc.calculate(hh, db, c); return null; } catch (e: any) { return { id: c.id, type: e.constructor.name, str: e.message }; } });
  const expected = g.errors.map((e: any) => ({ ...e, type: { ZeroDivisionError: "ZeroDivisionError", KeyError: "KeyError" }[e.type as string] }));
  sameJson(errors, expected);
  sameJson([[1010, 1000], [1030, 1000], [1031, 1000], [1, 500], [0, 500], [999.9, 250], [2000, 2000], [60, 60], [61.9, 60], [62, 60]].map(([a, b]) => [a, b, calc.packs(a, b)]), g.packs);
  sameJson(calc.macros(db, { haehnchenbrust: 333, reis: 77.7 }), g.macros);

  const ex = config.load(households.en);
  ex.raw.exclusions = ["Mushroom", "feta", "Nut-Free"];
  sameJson(g.exclusion_inputs.map((t: any) => calc.check_exclusions(ex, db, t)), g.exclusions);

  const d = tmpDir();
  copyDir(path.join(FX, "../../examples/household-en"), d);
  const hha = config.load(d);
  const add = { dinkelnudeln: { name: "Dinkelnudeln", kcal: 350, p: 12, kh: 70, eur_kg: 3.5, pack_g: 500, laden: "", aisle: "dry" },
    reis: { name: "overwrite attempt", kcal: 1 }, keks: { name: "Keks", kcal: 450, p: 5, kh: 70, eur_kg: 6, pack_g: 200, quelle: "kassenbon" } };
  assert.deepStrictEqual(calc.add_ingredients(hha, add), g.added);
  assert.deepStrictEqual(calc.add_ingredients(hha, add), g.added_again);
  sameJson(JSON.parse(fs.readFileSync(path.join(d, "ingredients.json"), "utf-8")), g.added_file);
  assert.equal(fs.readFileSync(path.join(d, "ingredients.json"), "utf-8"), g.added_text);
});

test("round_dates: next first-eating day, shopping/prep day before it, for many 'todays' and existing rounds", () => {
  const g: any[] = fixture("round-dates");
  const d = path.join(tmpDir(), "k");
  logs(() => cmd_init([d, "--lang", "en"]));
  for (const c of g) {
    const hh = config.load(d);
    hh.raw.language = c.lang;
    hh.raw.schedule = { ...hh.raw.schedule, ...c.sched };
    fixClock(c.today[0], c.today[1], c.today[2], 8, 0, 0);
    for (const kind of ["rounds", "weeks"]) for (const f of fs.readdirSync(hh.paths[kind])) fs.unlinkSync(path.join(hh.paths[kind], f));
    for (const [kind, id] of c.existing) fs.writeFileSync(path.join(hh.paths[kind], `${id}.json`), "{}");
    fs.writeFileSync(path.join(hh.paths.rounds, "notes.json"), "{}");
    sameJson(actions.round_dates(hh), c.result, JSON.stringify([c.lang, c.sched, c.today, c.existing]));
    assert.deepStrictEqual([actions.ids(hh.paths.weeks), actions.ids(hh.paths.rounds)], c.ids);
  }
  fixClock();
});
