// Household configuration (household.toml) and resolved paths.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { Fatal, KeyError, expandUser, mkdirp, pyRound, readText, resolveLoose, truthy, type Obj } from "./py.ts";

/** Package root: holds web/, prompts/, data/, examples/ — one level above src/ and dist/. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_PATHS: Record<string, string> = {
  profile: "profile.md", feedback: "feedback.md", pantry: "pantry.md", plans: "plans", rounds: "rounds",
  mailbox: "mailbox", weeks: "weeks", images: "img", jobs: "jobs", ingredients: "ingredients.json",
  kitchen: "kitchen.json",
};
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const int = (v: any): number => Math.trunc(Number(v));

export class Household {
  root: string;
  raw: Obj;
  paths: Record<string, string>;
  constructor(root: string, raw: Obj, paths: Record<string, string>) {
    this.root = root; this.raw = raw; this.paths = paths;
  }
  get name(): string { return this.raw.name ?? "Meal Prep Studio"; }
  get language(): string { return this.raw.language ?? "en"; }
  get persons(): Obj[] { return this.raw.persons; }
  get meals(): Obj[] { return this.raw.meals; }
  get fixed_meals(): Obj[] { return this.raw.fixed_meals ?? []; }
  get days(): number { return int(this.raw.schedule?.days ?? 4); }
  /** The last N eating days are frozen on prep day and thawed the evening before. */
  get freeze_days(): number { return Math.max(0, Math.min(int(this.raw.schedule?.freeze_days ?? 0), this.days - 1)); }
  get schedule(): Obj { return { days: 4, shopping_day: "sat", prep_day: "sun", first_day: "mon", ...this.raw.schedule }; }
  get budget(): number { return Number(this.raw.budget?.per_round ?? 50); }
  get currency(): string { return this.raw.budget?.currency ?? "€"; }
  get offers(): Obj {
    return { enabled: false, provider: "marktguru", zip: "", retailers: [], markup: {}, second_store_min_saving: 3.0, ...this.raw.offers };
  }
  get agent(): Obj {
    return { command: "claude", model: "sonnet", effort: "", timeout_min: 8, candidates_per_meal: 4, ...this.raw.agent };
  }
  get server(): Obj { return { host: "0.0.0.0", port: 8090, pin: "", ...this.raw.server }; }
  /** Words that must never appear in a suggestion (allergies, intolerances, hard dislikes). */
  get exclusions(): string[] { return (this.raw.exclusions ?? []).map((w: string) => w.toLowerCase()); }

  meal_target(mealId: string, personId: string): number {
    const meal = this.meals.find((m) => m.id === mealId);
    if (!meal) throw new Error(`no meal with id ${mealId}`);
    if ("targets" in meal) {
      if (!(personId in meal.targets)) throw new KeyError(personId);
      return Number(meal.targets[personId]);
    }
    const person = this.persons.find((p) => p.id === personId);
    if (!person) throw new Error(`no person with id ${personId}`);
    const fixed = this.fixed_meals.reduce((a, f) => a + (f.kcal ?? 0), 0);
    if (!("share" in meal)) throw new KeyError("share");
    return (person.kcal - fixed) * Number(meal.share);
  }

  /** What the web app may see (no pin, no paths). */
  public(): Obj {
    const meal_targets: Obj = {};
    for (const m of this.meals) {
      meal_targets[m.id] = {};
      for (const p of this.persons) meal_targets[m.id][p.id] = pyRound(this.meal_target(m.id, p.id));
    }
    return {
      name: this.name, language: this.language, persons: this.persons, meals: this.meals,
      fixed_meals: this.fixed_meals, days: this.days, freeze_days: this.freeze_days, budget: this.budget, currency: this.currency,
      offers: { enabled: this.offers.enabled, zip: this.offers.zip },
      pin: truthy(this.server.pin),
      meal_targets,
    };
  }
}

export function load(dataDir: string): Household {
  const root = resolveLoose(expandUser(dataDir));
  const cfgFile = path.join(root, "household.toml");
  if (!fs.existsSync(cfgFile)) throw new Fatal(`No household.toml in ${root}. Run:  mealprep-studio init ${root}`);
  const raw = parse(readText(cfgFile)) as Obj;
  for (const key of ["persons", "meals"]) {
    if (!truthy(raw[key])) throw new Fatal(`household.toml: [[${key}]] is missing`);
  }
  const paths: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...DEFAULT_PATHS, ...raw.paths })) paths[k] = path.resolve(root, v as string);
  // Python's `root / v` does not normalise; resolve() only differs for ".." segments, which stay inside the household anyway
  for (const k of ["plans", "rounds", "mailbox", "weeks", "images", "jobs"]) mkdirp(paths[k]);
  return new Household(root, raw, paths);
}
