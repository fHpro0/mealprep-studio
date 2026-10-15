// End-to-end parity: every action (new round, revise, plan, feedback) and the `calc` command run
// against a canned `claude` reply and a fake network; the files they leave behind, the progress
// phases, the prompts and the network traffic must equal what the Python version produced.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as actions from "../src/actions.ts";
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
