// Network and subprocess parity: the TS code must send exactly what the Python code sent
// (URLs, headers, claude CLI arguments) and map the answers to the same results.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as agent from "../src/agent.ts";
import * as config from "../src/config.ts";
import * as images from "../src/images.ts";
import * as offers from "../src/offers.ts";
import { FX, assertNet, copyDir, fixClock, fixture, installFakeClaude, installFakeNet, sameJson, snapshot, tmpDir } from "./helpers.ts";

const REPO = path.join(FX, "../..");

test("marktguru: API keys from the page, search URL + headers, filtering, error mapping", async () => {
  const g = fixture("net-unit");
  const net = installFakeNet(fixture("net"));
  try {
    const keys = await offers.get_keys();
    assert.deepStrictEqual(keys, g.keys);
    assertNet(net.take(), g.keys_net, "keys");
    sameJson(await offers.search("hähnchenbrust", "10115", keys, "2026-10-15", ["lidl", "rewe", "edeka"]), g.search);
    sameJson(await offers.search("eier", "10 115", keys, "2026-10-15", undefined, 5), g.search_all);
    assertNet(net.take(), g.search_net, "search");
    for (const q of ["magerquark", "kartoffeln", "zwiebeln"]) {
      const err = await offers.search(q, "10115", keys, "2026-10-15", []).then(() => null, (e: Error) => [e.constructor.name, e.message]);
      assert.deepStrictEqual(err, g["err_" + q], q);
    }
  } finally { net.restore(); }
});

test("Wikimedia Commons: search URL/UA, licence + size + title filters, retry on 429/503, credits, old photo removal", async () => {
  const g = fixture("net-unit");
  const net = installFakeNet(fixture("net"));
  try {
    const d = tmpDir();
    copyDir(path.join(REPO, "examples/household-en"), d);
    const hh = config.load(d);
    sameJson(await images.search("Roasted chicken rice"), g.commons_search);
    assertNet(net.take(), g.commons_search_net, "search");
    fs.mkdirSync(path.join(hh.paths.images, "kandidaten"), { recursive: true });
    fs.writeFileSync(path.join(hh.paths.images, "kandidaten", "old-dish.webp"), "old");
    fs.writeFileSync(path.join(hh.paths.images, "credits.json"), JSON.stringify({ "kandidaten/old-dish.webp": { nr: 1, file: "kandidaten/old-dish.webp" }, other: { nr: 3 } }));
    for (const f of g.fetches) {
      const [q, rel, nr] = f.args;
      const r = await images.fetch_(hh, q, rel, nr).catch(() => ["ERR"]);
      sameJson(r, f.result, JSON.stringify(f.args));
      assertNet(net.take(), f.net, JSON.stringify(f.args));
    }
    assert.deepStrictEqual(snapshot(d), g.images_tree);
    images.set_credit(hh, "other", null);
    sameJson(JSON.parse(fs.readFileSync(path.join(hh.paths.images, "credits.json"), "utf-8")), g.credits_after);
    assert.equal(fs.readFileSync(path.join(hh.paths.images, "credits.json"), "utf-8"), g.credits_text);
    await assert.rejects(images._get("https://upload.wikimedia.org/thumb/gone.jpg"), (e: any) => e.code === g.http404);
  } finally { net.restore(); }
});

test("claude CLI: arguments, schema, model, effort, timeout, cwd and answer handling", async () => {
  const g = fixture("agent-unit");
  const custom = tmpDir();
  copyDir(path.join(FX, "household-custom"), custom);
  const hh = config.load(custom);
  const replies: Record<string, string> = {
    ok: JSON.stringify({ is_error: false, structured_output: { nachricht: "hi", kandidaten: [] }, duration_ms: 4321, total_cost_usd: 0.0421 }),
    text_fallback: JSON.stringify({ is_error: false, result: 'Sure! {"a": {"b": 1}} done', duration_ms: 5 }),
    is_error: JSON.stringify({ is_error: true, result: "x".repeat(700) + "TAIL" }),
    is_error_none: JSON.stringify({ is_error: true }),
  };
  const proc: Record<string, [string, string]> = { garbage: ["not json", "some stderr " + "e".repeat(700) + "END"], garbage_nostderr: ["not json at all", ""], empty: ["", ""], no_json_in_text: [JSON.stringify({ result: "nothing here" }), ""] };
  for (const name of ["ok", "text_fallback", "is_error", "is_error_none", "garbage", "garbage_nostderr", "empty", "no_json_in_text"]) {
    const orig = agent.runner.exec;
    const calls: any[] = [];
    agent.runner.exec = async (cmd, args, opts) => {
      calls.push({ args: [path.basename(cmd), ...args], cwd: opts.cwd, timeout: opts.timeoutMs / 1000 });
      const [stdout, stderr] = name in replies ? [replies[name], ""] : proc[name];
      return { stdout, stderr };
    };
    let res: any;
    try { res = { ok: await agent.run(hh, "PROMPT äöü", agent.FEEDBACK_SCHEMA, hh.root) }; } catch (e: any) { res = { error: [e.constructor.name, e.message] }; }
    agent.runner.exec = orig;
    const exp = g[name];
    assert.equal(calls.length, 1);
    assert.deepStrictEqual(calls[0].args, exp.call.args, name + " args");
    assert.equal(calls[0].cwd, hh.root);
    assert.equal(calls[0].timeout, exp.call.timeout);
    if (exp.ok) sameJson(res.ok, exp.ok, name);
    else {
      assert.ok(res.error, name + " must fail");
      if (name !== "no_json_in_text") assert.equal(res.error[1], exp.error[1], name); // (JSON syntax error wording differs)
    }
  }
  // no effort configured: no --effort flag
  const en = tmpDir();
  copyDir(path.join(REPO, "examples/household-en"), en);
  const hhEn = config.load(en);
  const fake = installFakeClaude([JSON.stringify({ structured_output: { x: 1 } })]);
  try {
    await agent.run(hhEn, "P", agent.ROUND_SCHEMA, hhEn.root);
    assert.deepStrictEqual(fake.calls[0].args, g.noeffort_call.args);
  } finally { fake.restore(); }
  assert.equal(agent.system_prompt(hhEn), g.system_prompt_en);
  assert.equal(agent.system_prompt(hh), g.system_prompt_custom);
  sameJson({ ROUND: agent.ROUND_SCHEMA, PLAN: agent.PLAN_SCHEMA, FEEDBACK: agent.FEEDBACK_SCHEMA }, g.schemas);
});

test("claude is started with an args array, never through a shell", async () => {
  const dir = tmpDir();
  const stub = path.join(dir, "claude-stub");
  fs.writeFileSync(stub, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\necho '{\"structured_output\": {\"ok\": true}}'\n", { mode: 0o755 });
  const en = tmpDir();
  copyDir(path.join(REPO, "examples/household-en"), en);
  const hh = config.load(en);
  hh.raw.agent = { command: stub };
  const evil = "hello $(touch /tmp/mps-pwned) `id` ; rm -rf / \"quoted\" 'single'";
  const out = await agent.run(hh, evil, agent.FEEDBACK_SCHEMA, hh.root);
  assert.equal(out.ok, true);
  const args = fs.readFileSync(stub + ".args", "utf-8").split("\n");
  assert.equal(args[1], evil);
  assert.ok(!fs.existsSync("/tmp/mps-pwned"));
  // timeout kills the child and fails with a clear message
  fs.writeFileSync(stub, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  hh.raw.agent = { command: stub, timeout_min: 0.001 };
  await assert.rejects(agent.run(hh, "x", {}, hh.root), /timed out after 0\.06 seconds/);
  // missing executable is an error, not a hang
  hh.raw.agent = { command: path.join(dir, "nope") };
  await assert.rejects(agent.run(hh, "x", {}, hh.root), /ENOENT/);
});
