import assert from "node:assert/strict";
import test from "node:test";
import { BOTS, kitchen_valid } from "../src/server.ts";
import * as prices from "../src/prices.ts";
import * as render from "../src/render.ts";
import * as plate from "../src/plate.ts";
import * as kaufda from "../src/kaufda.ts";
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

test("plate illustration: deterministic, model output cannot inject markup", () => {
  const t = [{ name: "Sauce", farbe: "#c2412d", form: "sauce", anteil: 60 }, { name: "x", farbe: "red\"/><script>", form: "<g>", anteil: "9e9" }];
  const svg = plate.render("dish-1", "Feta <b>&</b>", t);
  assert.equal(svg, plate.render("dish-1", "Feta <b>&</b>", t));
  assert.ok(svg.startsWith("<svg") && svg.includes("<title>Feta &lt;b&gt;&amp;&lt;/b&gt;</title>"));
  assert.ok(!svg.includes("<script") && !svg.includes("red\""));
  assert.deepStrictEqual(plate.clean(t)[1], { name: "x", farbe: "#b8a58a", form: "stuecke", anteil: 100 });
  assert.deepStrictEqual(plate.clean("nope"), []);
});

test("offer verdict: compared with the household's normal price per kg, and the store's own 'instead of' price", () => {
  const db = { hack: { name: "Hack gemischt", suche: "hackfleisch", muss: "hack", nicht: "vom hähnchen", eur_kg: 10, regulaer_eur_kg: 8 },
    joghurt: { name: "Naturjoghurt", suche: "naturjoghurt", muss: "natur", eur_kg: 2 },
    lauch: { name: "Lauch", suche: "lauch", eur_kg: 2.4 }, ruecken: { name: "Rücken", suche: "schweinerücken", eur_kg: 3.99, quelle: "schaetzung" }, note: "comment" };
  const o = (produkt: string, grundpreis: number | null, extra = {}) => ({ produkt, marke: "", preis: 3, grundpreis, einheit: "kg", ...extra });
  assert.deepStrictEqual(prices.verdict(db, o("Hackfleisch gemischt", 6)), { zutat: "Hack gemischt", normal_eur_kg: 8, vs_normal: -25, urteil: "echt" });
  assert.equal(prices.verdict(db, o("Hackfleisch", 7.6)).urteil, "knapp");
  assert.equal(prices.verdict(db, o("Hackfleisch", 8.5)).urteil, "schein");
  assert.equal(prices.verdict(db, o("Hackfleisch vom Hähnchen", 5)).urteil, "unbekannt");
  assert.equal(prices.verdict(db, o("Bio-Landhähnchen Flügel natur", 6)).urteil, "unbekannt", "loose pattern alone is no match");
  assert.equal(prices.verdict(db, o("Knoblauch granuliert", 10)).urteil, "unbekannt", "word starts only");
  assert.equal(prices.verdict(db, o("Lauch", 1.2)).urteil, "echt");
  assert.equal(prices.verdict(db, o("Schweinerücken", 3.99)).urteil, "unbekannt", "an estimate is no normal price");
  assert.equal(prices.verdict(db, o("Hackfleisch", 19)).urteil, "unbekannt", "far above normal: another product");
  assert.deepStrictEqual(prices.verdict(db, o("Brie", null, { alter_preis: 4 })), { zutat: null, normal_eur_kg: null, laden_rabatt: 25, urteil: "laut_laden" });
});

test("kaufDA offer cards: price per kg, validity in German time, store id, strike price", () => {
  assert.deepStrictEqual(kaufda.base_price("(6.23 / kg)"), [6.23, "kg"]);
  assert.deepStrictEqual(kaufda.base_price("(1 kg = 18.73)"), [18.73, "kg"]);
  assert.deepStrictEqual(kaufda.base_price("(App: 4.36 / kg)"), [4.36, "kg"]);
  assert.equal(kaufda.base_price(""), null);
  const card = { id: "x1", title: "Hackfleisch vom Hähnchen", publisherName: "Netto Marken-Discount",
    validFrom: "2026-10-25T23:00:00.000+0000", validUntil: "2026-10-31T19:00:00.000+0000",
    prices: { mainPrice: 2.49, secondaryPrice: 2.99, secondaryPriceIsUVP: true, priceByBaseUnit: "(6.23 / kg)" } };
  assert.deepStrictEqual(kaufda.normalize(card), {
    produkt: "Hackfleisch vom Hähnchen", marke: "", laden: "Netto Marken-Discount", laden_id: "netto-marken-discount",
    preis: 2.49, grundpreis: 6.23, einheit: "kg", gueltig_von: "2026-10-26", gueltig_bis: "2026-10-31",
    treueprogramm: false, id: "kaufda-x1", quelle: "kaufDA", alter_preis: 2.99 });
  assert.equal(kaufda.normalize({ ...card, publisherName: "dm" }), null);
  assert.equal(kaufda.normalize({ ...card, title: "10% Rabatt", prices: { mainPrice: 0 } }), null);
  assert.equal(kaufda.normalize({ ...card, publisherName: "E center" })!.laden_id, "edeka");
});
