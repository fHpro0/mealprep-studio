import assert from "node:assert/strict";
import test from "node:test";
import { BOTS, kitchen_valid } from "../src/server.ts";
import * as prices from "../src/prices.ts";
import * as render from "../src/render.ts";
import { Household } from "../src/config.ts";
import { fixture, sameJson } from "./helpers.ts";

test("price planning: best offer per retailer, store plans for several min-saving thresholds", () => {
  const g = fixture("prices-unit");
  sameJson(prices._best_per_retailer(g.best_inputs.z, g.best_inputs.rows), g.best);
  const { prices: pf, items } = g.plan_inputs;
  for (const ms of [0, 1, 3, 50]) sameJson(prices.plan_stores(pf, structuredClone(items), ms), g.plans[String(ms.toFixed(1))], "min saving " + ms);
  sameJson(prices.plan_stores(null, structuredClone(items), 3), g.plan_noprices);
  sameJson(prices.plan_stores({ ...pf, laeden: { lidl: "Lidl" } }, structuredClone(items), 3), g.plan_single);
});

test("kitchen inventory validation: same accepted values, same error messages", () => {
  const g = fixture("kitchen-valid");
  g.cases.forEach((c: unknown, i: number) => {
    const exp = g.results[i];
    let got: any;
    try { got = { ok: kitchen_valid(c) }; } catch (e: any) { got = { error: e.message }; }
    sameJson(got, exp, "case " + i + ": " + JSON.stringify(c).slice(0, 80));
  });
});

test("week plan Markdown is identical (EN, DE, unknown language falls back to EN)", () => {
  const g = fixture("render");
  const mk = (language: string) => new Household("/x", { language, budget: { per_round: 60, currency: "CHF" }, persons: [], meals: [] }, {});
  for (const lang of ["de", "en", "xx"]) assert.equal(render.week_markdown(mk(lang), structuredClone(g.inputs.week)), g.outputs[lang], lang);
  assert.equal(render.week_markdown(new Household("/x", { language: "en", persons: [], meals: [] }, {}), structuredClone(g.inputs.week2)), g.outputs.minimal);
});

test("bot detection list", () => {
  for (const ua of ["Googlebot/2.1", "GPTBot/1.0", "curl/8.4.0", "WhatsApp/2.23", "python-requests/2.31", "ClaudeBot", "facebookexternalhit/1.1", "Slackbot-LinkExpanding", "Wget/1.21", "AhrefsBot"]) {
    assert.ok(BOTS.test(ua), ua);
  }
  for (const ua of ["", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1", "Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0"]) assert.ok(!BOTS.test(ua), ua);
});
