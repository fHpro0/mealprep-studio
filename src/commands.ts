// Command line: init | serve | run | calc | check
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import * as actions from "./actions.ts";
import { runner, which } from "./agent.ts";
import * as calc from "./calc.ts";
import * as config from "./config.ts";
import * as prices from "./prices.ts";
import { Fatal, expandUser, floatStr, fmtFixed, iso, pyRound, today, type Obj } from "./py.ts";
import * as offers from "./offers.ts";

export const USAGE = `mealprep-studio — command line.

    mealprep-studio init  <dir> [--lang de|en]   create a household folder from the example
    mealprep-studio serve <dir> [--port N]       start the web app (LAN)
    mealprep-studio run   <dir> <action> [id]    run an action without the web app
                                          actions: neue_runde | ueberarbeiten | plan_erstellen | feedback_uebernehmen
    mealprep-studio calc  <dir> <round-id>       recalculate macros/costs of a round (after hand edits)
    mealprep-studio check <dir>                  validate config, ingredient DB, claude CLI, offers
`;

/** The LAN address other devices can reach (UDP "connect" sends nothing). */
function lanIp(): Promise<string> {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.once("error", () => { s.close(); resolve(""); });
    s.connect(1, "10.255.255.255", () => {
      try { resolve(s.address().address); } catch { resolve(""); }
      s.close();
    });
  });
}

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (i + 1 >= args.length) throw new Fatal(`${name} needs a value`);
  return args[i + 1];
};

export function cmd_init(args: string[]): void {
  const target = expandUser(args[0]);
  const lang = flag(args, "--lang") ?? "en";
  const src = path.join(config.REPO, "examples", `household-${lang}`);
  if (!/^[a-z]+$/.test(lang) || !fs.existsSync(src)) throw new Fatal(`unknown --lang ${lang} (use en or de)`);
  if (fs.existsSync(path.join(target, "household.toml"))) throw new Fatal(`${target}/household.toml already exists — nothing overwritten.`);
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (!fs.existsSync(path.join(target, f))) fs.copyFileSync(path.join(src, f), path.join(target, f));
  }
  console.log(`Created ${target}. Edit household.toml and profile.md, then:  mealprep-studio serve ${target}`);
}

export async function cmd_serve(args: string[]): Promise<void> {
  const { serve } = await import("./server.ts");
  const hh = config.load(args[0]);
  const p = flag(args, "--port");
  const { port } = await serve(hh, p === undefined ? null : Number.parseInt(p, 10));
  console.log(`${hh.name}\n  this computer:  http://localhost:${port}`);
  const ip = await lanIp();
  if (ip) console.log(`  phone / LAN:    http://${ip}:${port}`);
  if (!hh.server.pin) console.log('  note: no PIN set — anyone on your network can trigger the planner ([server] pin = "…")');
}

export async function cmd_run(args: string[]): Promise<void> {
  const hh = config.load(args[0]);
  const action = args[1], ident = args.length > 2 ? args[2] : "";
  if (!Object.hasOwn(actions.ACTIONS, action)) throw new Fatal(`unknown action ${action} (${Object.keys(actions.ACTIONS).join(" | ")})`);
  console.log(await actions.ACTIONS[action](hh, ident, (phase) => console.log(`… ${phase}`)));
  while (actions.BACKGROUND.size) await Promise.all([...actions.BACKGROUND]);
}

export async function cmd_calc(args: string[]): Promise<void> {
  const hh = config.load(args[0]);
  const db = calc.load_ingredients(hh);
  const p = path.join(hh.paths.rounds, `${args[1]}.json`);
  const r = actions.read(p);
  if (!r) throw new Fatal(`no round ${p}`);
  for (const c of r.kandidaten) {
    calc.calculate(hh, db, c);
    const m: Obj = c.makros;
    console.log(`${String(c.id).padEnd(22)} ` + Object.keys(m).map((q) => `${q} ${m[q].kcal} kcal ${m[q].p} g P`).join(" | ")
      + ` | ${fmtFixed(c.kosten, 2)} | x${floatStr(c.berechnet.skalierung)}`);
  }
  const pr = await prices.compare(hh, db, r, r.einkauf_iso || iso(today()));
  if (pr) actions.write(path.join(path.dirname(p), path.parse(p).name + "-preise.json"), pr);
  actions.write(p, r);
}

export async function cmd_check(args: string[]): Promise<number> {
  const hh = config.load(args[0]);
  const db = calc.load_ingredients(hh);
  let ok = true;
  console.log(`household: ${hh.name} · ${hh.persons.length} persons · meals ${pyList(hh.meals.map((m) => m.id))} · ${hh.days} days`);
  for (const m of hh.meals) {
    console.log(`  ${m.id}: ` + hh.persons.map((p) => `${p.id} ${pyRound(hh.meal_target(m.id, p.id))} kcal`).join(", "));
  }
  const bad = Object.entries<Obj>(db).filter(([, v]) => !["name", "kcal", "p", "kh", "eur_kg", "pack_g"].every((x) => Object.hasOwn(v, x))).map(([k]) => k);
  console.log(`ingredients: ${Object.keys(db).length} (${!bad.length ? "ok" : "incomplete: " + bad.join(", ")})`);
  ok = ok && !bad.length;
  const cli = which(hh.agent.command);
  try {
    const v = (await runner.exec(cli, ["--version"], { cwd: process.cwd(), timeoutMs: 20000 })).stdout.trim();
    console.log(`claude cli: ${v}`);
  } catch {
    console.log("claude cli: NOT FOUND — install Claude Code (https://claude.com/claude-code) and log in");
    ok = false;
  }
  if (hh.offers.enabled) {
    try {
      await offers.get_keys();
      console.log(`offers: marktguru reachable, zip ${hh.offers.zip}, retailers ${hh.offers.retailers?.length ? pyList(hh.offers.retailers) : "all"}`);
    } catch (e: any) {
      console.log(`offers: not available (${e.message}) — planning still works with estimated prices`);
    }
  } else {
    console.log("offers: disabled");
  }
  return ok ? 0 : 1;
}

/** Python's list repr for strings: ['a', 'b'] */
const pyList = (xs: string[]) => "[" + xs.map((x) => `'${x}'`).join(", ") + "]";

export async function main(a: string[]): Promise<void> {
  const cmds: Record<string, (args: string[]) => unknown> = { init: cmd_init, serve: cmd_serve, run: cmd_run, calc: cmd_calc, check: cmd_check };
  if (!a.length || !Object.hasOwn(cmds, a[0]) || a.length < 2) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  try {
    const code = await cmds[a[0]](a.slice(1));
    if (typeof code === "number") process.exitCode = code;
  } catch (e: any) {
    console.error(e instanceof Fatal ? e.message : e?.stack ?? String(e));
    process.exitCode = 1;
  }
}
