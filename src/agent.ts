// One structured Claude call per action — no tools, no file browsing.
//
// The server assembles everything Claude needs into one prompt and asks for JSON matching a schema
// (`claude -p --json-schema`). Calculations, prices, images and file writes happen in TypeScript.
// That turns a multi-minute agent loop into a single answer (typically 20–60 s).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, type Household } from "./config.ts";
import { cpSlice, dumps, need, floatStr, fmtFixed, pyRound, pySum, pyStr, readText, truthy, type Obj } from "./py.ts";

export { FEEDBACK_SCHEMA, PLAN_SCHEMA, ROUND_SCHEMA } from "./schemas.ts";

const LANG: Record<string, string> = { de: "German", en: "English" };

export function system_prompt(hh: Household): string {
  const rules = readText(path.join(REPO, "prompts", "rules.md"));
  return `You are the meal-prep planner of one household. Write every user-facing text in ${LANG[hh.language] ?? hh.language}. Reply only with the requested JSON.\n\n${rules}`;
}

function json(p: string): any {
  try {
    return JSON.parse(readText(p));
  } catch {
    return null;
  }
}

function read(p: string, limit = 30000): string {
  if (!fs.existsSync(p)) return "(none)";
  const t = readText(p);
  const cps = [...t];
  return cps.length <= limit ? t : "…(older part cut)…\n" + cps.slice(-limit).join("");
}

export function household_context(hh: Household, db: Obj, deals: string): string {
  const persons = hh.persons.map((p) => `- ${p.id} (${p.name ?? ""}): ${p.kcal} kcal/day, protein ~${p.protein ?? "?"} g`).join("\n");
  const meals = hh.meals.map((m) =>
    `- slot \`${m.id}\`: ${m.label ?? m.id}${truthy(m.cold) ? " — eaten COLD from a box" : ""}; `
    + hh.persons.map((p) => `${p.id} ${pyRound(hh.meal_target(m.id, p.id))} kcal`).join(", ")
    + ` → one dish = ${hh.days * hh.persons.length} portions ≈ `
    + `${fmtFixed(pyRound(hh.days * pySum(hh.persons.map((p) => hh.meal_target(m.id, p.id))), -2), 0)} kcal in total`).join("\n");
  const fixed = hh.fixed_meals.map((f) => `- ${f.name}: ${f.kcal ?? 0} kcal (not planned by you)`).join("\n") || "(none)";
  const ingr = Object.entries<Obj>(db).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k} | ${need(v, "name")} | ${need(v, "kcal")}/${need(v, "p")}/${need(v, "kh")} | ${need(v, "eur_kg")} €/kg | ${v.laden ?? ""}`).join("\n");
  const k: Obj[] = json(hh.paths.kitchen)?.items || [];
  const kitchen = k.filter((i) => truthy(i.anz)).map((i) => `- ${i.anz}× ${i.name}` + (truthy(i.notiz) ? ` — ${i.notiz}` : "")).join("\n")
    || "(not recorded — assume a normal home kitchen: 1 oven with 1 baking tray, 2 pots, 1 pan)";
  const f = hh.freeze_days;
  const freeze = f
    ? `Freezer: the portions for the last ${f} eating day(s) (days ${hh.days - f + 1}–${hh.days}) go into the freezer `
      + `on prep day, as soon as they are cool. Follow the freezer rules. Add \`vorbereitung\` entries to move `
      + `them to the fridge the evening before they are eaten.`
    : "Freezer: not used, everything is eaten fresh.";
  return `# Household
Persons (one round = ${hh.days} days, everything is cooked once on prep day):
${persons}
${freeze}
Meals you plan:
${meals}
Fixed meals:
${fixed}
Budget per round: ${floatStr(hh.budget)} ${hh.currency} for everything. Hard exclusions (never, not even traces): ${hh.exclusions.join(", ") || "(none)"}

## Profile
${read(hh.paths.profile)}

## Feedback log (most important input)
${read(hh.paths.feedback)}

## Pantry
${read(hh.paths.pantry, 4000)}

## Kitchen equipment
Use ONLY this equipment and respect the notes (size, depth, capacity). Never plan more of an item than listed.
A shallow baking tray cannot hold liquid sauce: use a deep dish or pot, or a different technique.
${kitchen}

## Offers near the household this week
${deals}

## Ingredient database
Use ONLY these keys in \`rechnung\` (grams). The \`rechnung\` of one dish must add up to roughly the total kcal
above (±20 %). Low-calorie targets come from smaller portions, not from a recipe without fat or starch. Columns: key | name | kcal/protein/carbs per 100 g | price | store.
If you truly need another ingredient, add it under \`neue_zutaten\` with honest per-100 g values.
Spices, garlic, lemon juice, salt: leave them out of \`rechnung\` (mention them in the pitch/recipe).
${ingr}
`;
}

/** shutil.which(); falls back to ~/.local/bin/<command> like the original. */
export function which(command: string): string {
  const ok = (p: string) => {
    try {
      return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true);
    } catch {
      return false;
    }
  };
  if (command.includes("/")) return ok(command) ? command : path.join(os.homedir(), ".local/bin", command);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && ok(path.join(dir, command))) return path.join(dir, command);
  }
  return path.join(os.homedir(), ".local/bin", command);
}

/** Runs a program with an args array (never through a shell). Tests replace `runner.exec`. */
export const runner = {
  exec(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", done = false;
      child.stdout.setEncoding("utf-8").on("data", (d) => (stdout += d));
      child.stderr.setEncoding("utf-8").on("data", (d) => (stderr += d));
      const timer = setTimeout(() => {
        done = true;
        child.kill("SIGKILL");
        reject(new Error(`Command '${path.basename(cmd)}' timed out after ${opts.timeoutMs / 1000} seconds`));
      }, opts.timeoutMs);
      child.on("error", (e) => { clearTimeout(timer); if (!done) { done = true; reject(e); } });
      child.on("close", () => { clearTimeout(timer); if (!done) { done = true; resolve({ stdout, stderr }); } });
    });
  },
};

export async function run(hh: Household, prompt: string, schema: Obj, cwd: string): Promise<Obj> {
  const a = hh.agent;
  const cmd = which(a.command);
  const args = ["-p", prompt, "--output-format", "json", "--json-schema", dumps(schema, undefined, true),
    "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
    "--system-prompt", system_prompt(hh), "--model", a.model];
  if (truthy(a.effort)) args.push("--effort", a.effort);
  const p = await runner.exec(cmd, args, { cwd, timeoutMs: a.timeout_min * 60 * 1000 });
  let res: Obj;
  try {
    res = JSON.parse(p.stdout);
  } catch {
    throw new Error(cpSlice(p.stderr || p.stdout || "no output from claude", -600));
  }
  if (res.is_error) throw new Error(cpSlice(pyStr(res.result), -600));
  let out = res.structured_output;
  if (out === undefined || out === null) { // older CLI versions: JSON in the text result
    const txt: string = res.result ?? "";
    out = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
  }
  out._meta = { dauer_ms: res.duration_ms, kosten_usd: res.total_cost_usd };
  return out;
}
