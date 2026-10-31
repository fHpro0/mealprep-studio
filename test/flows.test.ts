// End-to-end parity: every action (new round, revise, plan, feedback) and the `calc` command run
// against a canned `claude` reply and a fake network; the files they leave behind, the progress
// phases, the prompts and the network traffic must equal what the Python version produced.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as actions from "../src/actions.ts";
import * as prices from "../src/prices.ts";
import { RETAILERS } from "../src/offers.ts";
import { cmd_calc, cmd_check, cmd_init } from "../src/commands.ts";
import * as config from "../src/config.ts";
import { dumps } from "../src/py.ts";
import { FX, assertNet, dropFloatZero, sameText, copyDir, delta, fixClock, fixture, installFakeClaude, installFakeNet, sameJson, snapshot, tmpDir } from "./helpers.ts";

async function captured(fn: () => unknown): Promise<string> {
  const orig = console.log;
  let out = "";
  console.log = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  try { await fn(); } finally { console.log = orig; }
  return out;
}

async function replay(name: "en" | "custom") {
  const flow: any[] = fixture("flows")[name];
  fixClock();
  const net = installFakeNet(fixture("net"));
  let root: string;
  if (name === "en") {
    root = path.join(tmpDir(), "kitchen");
    await captured(() => cmd_init([root, "--lang", "en"]));
  } else {
    root = tmpDir();
    copyDir(path.join(FX, "household-custom"), root);
  }
  const hh = config.load(root);
  let prev = snapshot(root);
  try {
    for (const step of flow) {
      for (const [rel, data] of Object.entries(step.inputs)) fs.writeFileSync(path.join(root, rel), dumps(data, 1));
      let message: string | undefined, phases: string[] = [], calls: any[] = [], stdout: string | undefined;
      if (step.name === "calc") {
        stdout = await captured(() => cmd_calc([root, step.inputs && Object.keys(step.inputs)[0].match(/rounds\/(.*)\.json/)![1]]));
      } else {
        const fake = installFakeClaude(step.replies.map((r: unknown) => JSON.stringify(r)));
        try {
          message = await actions.ACTIONS[step.action](hh, step.id, (p) => phases.push(p));
          while (actions.BACKGROUND.size) await Promise.all([...actions.BACKGROUND]);
          calls = fake.calls;
        } finally { fake.restore(); }
      }
      const label = `${name}/${step.name}`;
      assertNet(net.take(), step.net, label + " net");
      if (stdout !== undefined) assert.equal(stdout, step.stdout, label + " stdout");
      else {
        assert.equal(message, step.message, label + " message");
        assert.deepStrictEqual(phases, step.phases, label + " phases");
        assert.equal(calls.length, step.calls.length, label + " claude calls");
        step.calls.forEach((c: any, i: number) => {
          assert.equal(calls[i].args.length, c.args.length);
          c.args.forEach((arg: string, n: number) => sameText(calls[i].args[n], dropFloatZero(arg), `${label} claude arg ${n} of call #${i}`));
          assert.equal(calls[i].timeout, c.timeout);
          assert.equal(calls[i].cwd, hh.root);
        });
      }
      const cur = snapshot(root);
      const d = delta(prev, cur);
      // inputs written by the "web app" show up in the next step's delta, exactly as in the golden run
      assert.deepStrictEqual(Object.keys(d.changed), Object.keys(step.delta.changed), label + " changed files");
      for (const [k, v] of Object.entries(step.delta.changed)) {
        if (typeof v === "string") assert.equal(d.changed[k], v, `${label} ${k}`);
        else sameJson(d.changed[k], v, `${label} ${k}`);
      }
      assert.deepStrictEqual(d.removed, step.delta.removed);
      prev = cur;
    }
  } finally { net.restore(); }
  return { hh, root };
}

test("English household: new round → revise → plan (twice, backups) → feedback → next round", async () => {
  const { hh } = await replay("en");
  // a plan without one chosen dish per meal is refused with the same text
  fs.writeFileSync(path.join(hh.paths.mailbox, "2026-10-19.json"), JSON.stringify({ auswahl: { lunch: "lunch-chicken-bowl" } }));
  await assert.rejects(actions.plan(hh, "2026-10-19", () => {}), { message: fixture("flows").en_plan_error[1] });

  // fresh ideas for an open round: same dates, old dishes listed as "do not repeat", picks reset, old round backed up
  await assert.rejects(actions.new_round(hh, "2026-10-19", () => {}), /already planned/);
  const open = actions.ids(hh.paths.rounds).at(-1)!, p = path.join(hh.paths.rounds, `${open}.json`), before = actions.read(p);
  fs.writeFileSync(path.join(hh.paths.mailbox, `${open}.json`), JSON.stringify({ auswahl: { lunch: "x" }, reaktionen: { x: { daumen: 1 } }, wuensche: ["w"] }));
  const reply = fixture("flows").en.find((s: any) => s.name === "neue_runde_2").replies;
  const net = installFakeNet(fixture("net")), fake = installFakeClaude(reply.map((r: unknown) => JSON.stringify(r)));
  try {
    await actions.new_round(hh, open, () => {});
    while (actions.BACKGROUND.size) await Promise.all([...actions.BACKGROUND]);
    assert.ok(fake.calls[0].args[2].includes("# Dishes suggested in the last rounds\n- 2026-10-19 · lunch: Chicken rice bowl\n"));
  } finally { fake.restore(); net.restore(); }
  const after = actions.read(p);
  assert.equal(after.id, open);
  assert.equal(after.zeitraum, before.zeitraum);
  assert.deepStrictEqual(actions.read(path.join(hh.paths.mailbox, `${open}.json`)), { wuensche: ["w"] });
  assert.ok(fs.readdirSync(path.join(hh.paths.jobs, "backups")).some((f) => f.startsWith(open + ".")));
});

test("German household with offers, three persons, freezer, custom folders: round → plan → calc", async () => {
  await replay("custom");
});

test("check: same report and exit code", async () => {
  const g = fixture("check");
  const net = installFakeNet(fixture("net"));
  const stubDir = tmpDir();
  fs.writeFileSync(path.join(stubDir, "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = stubDir + path.delimiter + oldPath;
  try {
    const en = path.join(tmpDir(), "k");
    await captured(() => cmd_init([en, "--lang", "en"]));
    const bad = tmpDir();
    copyDir(path.join(FX, "household-custom"), bad);
    const ing = JSON.parse(fs.readFileSync(path.join(bad, "ingredients.json"), "utf-8"));
    ing.kaputt = { name: "Unvollständig" };
    fs.writeFileSync(path.join(bad, "ingredients.json"), JSON.stringify(ing));
    for (const [name, dir] of [["en", en], ["custom", bad]] as const) {
      let code: number | undefined;
      const out = await captured(async () => { code = await cmd_check([dir]); });
      assert.equal(out, g[name].stdout, name);
      assert.equal(code, g[name].code, name);
      assertNet(net.take(), g[name].net, name + " net");
    }
  } finally { process.env.PATH = oldPath; net.restore(); }
});

test("leaflet for idea finding: best 2 stores only, deduplicated, excluded words dropped, cached", async () => {
  fixClock();
  const root = tmpDir();
  copyDir(path.join(FX, "household-custom"), root);
  const hh = config.load(root);
  const day = actions.round_dates(hh).einkauf_iso;
  delete hh.raw.offers.browse;
  assert.deepStrictEqual(hh.offers.browse, config.BROWSE, "on by default");
  hh.raw.offers.browse = ["hähnchenbrust", "hackfleisch gemischt", "hähnchen hack"];
  // the leaflet asks for 100 hits; reuse the recorded 40-hit answers
  const recorded = fixture("net");
  const net = installFakeNet({ ...recorded, ...Object.fromEntries(Object.entries(recorded).map(([u, v]) => [u.replace("&limit=40&", "&limit=100&"), v])) });
  try {
    const { text, stores } = await prices.browse_digest(hh, day);
    assert.equal(stores.length, 2);
    assert.match(text, /^## hähnchenbrust\n- .+ · .+ · \d+\.\d\d €/);
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    const names = stores.map((id) => RETAILERS[id].toLowerCase());
    assert.ok(lines.length > 0 && lines.every((l) => names.some((n) => l.toLowerCase().split(" · ")[1].includes(n))), "only offers of the chosen stores");
    assert.equal(new Set(lines).size, lines.length);
    assert.ok(!/nuss/i.test(text));
    net.take();
    assert.deepStrictEqual(await prices.browse_digest(hh, day), { text, stores });
    assert.deepStrictEqual(net.take().requests, []);
    // a revision keeps the round's stores
    const other = (await prices.browse_digest(hh, day, ["lidl"]));
    assert.deepStrictEqual(other.stores, ["lidl"]);
    assert.ok(other.text.split("\n").filter((l) => l.startsWith("- ")).every((l) => / · lidl/i.test(l)));
  } finally { net.restore(); }
  hh.raw.offers.browse = [];
  assert.deepStrictEqual(await prices.browse_digest(hh, day), { text: "", stores: [] });
});

test("store choice: the pair that covers the most categories near the best price", () => {
  const o = (id: string, g: number) => ({ laden_id: id, grundpreis: g, einheit: "kg" });
  const found = { a: [o("x", 5), o("y", 9), o("z", 5.5)], b: [o("y", 4), o("x", 8), o("z", 4.2)], c: [o("x", 3), o("z", 9)] };
  assert.deepStrictEqual(prices.pick_stores(found, 2), ["x", "y"]);
  assert.deepStrictEqual(prices.pick_stores(found, 1), ["x"]); // x and z tie, first wins
  assert.deepStrictEqual(prices.pick_stores({}, 2), []);
});

test("local AI photos replace drawn plates, one per dish with a photo description", async () => {
  const root = path.join(tmpDir(), "k");
  await captured(() => cmd_init([root, "--lang", "en"]));
  const hh = config.load(root);
  const bin = tmpDir(), log = path.join(bin, "args.txt");
  // fake generator: records its arguments and writes the file given after --output
  fs.writeFileSync(path.join(bin, "gen"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${log}\nwhile [ $# -gt 0 ]; do [ "$1" = --output ] && printf png > "$2"; shift; done\n`, { mode: 0o755 });
  hh.raw.images = { ai: `${path.join(bin, "gen")} --steps 8` };
  const p = path.join(hh.paths.rounds, "2026-11-02.json");
  fs.mkdirSync(hh.paths.rounds, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ kandidaten: [
    { id: "chili", slot: "dinner", bild: "img/kandidaten/chili.svg?v=1", bild_prompt: "chili with a bubbly cheese crust" },
    { id: "plain", slot: "lunch", bild: "img/kandidaten/plain.svg?v=1" },
    { id: "../evil", slot: "lunch", bild: "img/kandidaten/x.svg", bild_prompt: "x" },
  ] }));
  let changes = 0;
  await actions.fetch_images_async(hh, p, () => changes++);
  const k = actions.read(p).kandidaten;
  assert.match(k[0].bild, /^img\/kandidaten\/chili\.png\?v=[0-9a-f]{8}$/);
  assert.equal(k[1].bild, "img/kandidaten/plain.svg?v=1");
  assert.equal(k[2].bild, "img/kandidaten/x.svg");
  assert.equal(changes, 1);
  const args = fs.readFileSync(log, "utf-8");
  assert.match(args, /^--steps\n8\n--seed\n\d+\n--output\n/);
  assert.match(args, /food photograph.*steam rising\. chili with a bubbly cheese crust/);
});
