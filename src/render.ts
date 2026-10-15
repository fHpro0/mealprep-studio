// Week plan JSON → printable Markdown (recipes, shopping list, equipment, prep timeline).
import type { Household } from "./config.ts";
import { ddmm, fmtFixed, fromIso, truthy, type Obj } from "./py.ts";

const T: Record<string, Record<string, string>> = {
  de: {
    shop: "Einkauf", prep: "Prep", days: "Essen", recipes: "Rezepte", kipp: "Hier kippt es",
    plate: "Täglich anrichten", portion: "Portion", list: "Einkaufsliste", sum: "Summe", budget: "Budget",
    pantry: "Vorher im Schrank nachsehen", dont: "Nicht kaufen", need: "Was benötigt wird",
    steps: "Ablauf am Prep-Tag", store: "Lagerung", why: "Warum dieser Plan", fb: "Feedback-Fragen",
    for: "für alle", portions: "Portionen", offer: "Angebot", est: "~",
    daily: "Vorbereiten & täglich zusammenbauen", assemble: "zusammenbauen", min: "Min",
    how: "So geht's",
  },
  en: {
    shop: "Shopping", prep: "Prep", days: "Eating", recipes: "Recipes", kipp: "Make-or-break step",
    plate: "Plate it daily", portion: "Portion", list: "Shopping list", sum: "Total", budget: "Budget",
    pantry: "Check the pantry first", dont: "Don't buy", need: "What you need",
    steps: "Prep-day timeline", store: "Storage", why: "Why this plan", fb: "Feedback questions",
    for: "for all", portions: "portions", offer: "offer", est: "~",
    daily: "Prepare & assemble daily", assemble: "assemble", min: "min",
    how: "How to cook",
  },
};

const numbered = (xs: string[]) => xs.map((s, i) => `${i + 1}. ${s}`);

export function week_markdown(hh: Household, w: Obj): string {
  const t = T[hh.language] ?? T.en;
  const cur = hh.currency;
  let out: string[] = [
    `# ${w.titel} — ${w.zeitraum}`, "",
    `**${t.shop}:** ${w.einkaufstag} · **${t.prep}:** ${w.preptag} · `
    + `**${t.sum}:** ${fmtFixed(w.budget.summe, 2)} ${cur} / ${t.budget} ${fmtFixed(w.budget.limit, 0)} ${cur}`, "",
  ];
  out.push("| | " + w.rezepte.map((r: Obj) => r.titel).join(" | ") + " | kcal/Tag |", "|---|" + "---|".repeat(w.rezepte.length + 1));
  const fixed = w.fruehstueck?.kcal ?? 0;
  for (const [pid, p] of Object.entries<Obj>(w.personen)) {
    const cells = w.rezepte.map((r: Obj) => `${r.makros[pid].kcal} kcal · ${r.makros[pid].p} g P`);
    const sum = w.rezepte.reduce((a: number, r: Obj) => a + r.makros[pid].kcal, 0);
    out.push(`| **${p.label}** | ` + cells.join(" | ") + ` | ${fixed + sum} |`);
  }
  out.push("", `## ${t.recipes}`, "");
  for (const r of w.rezepte) {
    out.push(`### ${r.titel} (${r.slot}, ${r.portionen} ${t.portions})`, "", `*${r.untertitel}*`, "");
    for (const g of r.zutaten) out.push(`**${g.gruppe}**`, ...g.items.map((i: string) => `- ${i}`), "");
    if (truthy(r.schritte)) out.push(`**${t.how}**`, ...numbered(r.schritte), "");
    out.push(`> **${t.kipp}:** ${r.kipppunkt}`, "", `**${t.plate}**`, ...numbered(r.anrichten), "");
    for (const [pid, lines] of Object.entries<string[]>(r.portion ?? {})) {
      const label = w.personen[pid]?.label ?? pid;
      out.push(`- **${t.portion} ${label}:** ` + lines.join("; "));
    }
    out.push("");
  }
  for (const x of w.extras ?? []) {
    out.push(`### ${x.titel}`, "");
    if (truthy(x.untertitel)) out.push(`*${x.untertitel}*`, "");
    for (const g of x.zutaten ?? []) out.push(`**${g.gruppe}**`, ...g.items.map((i: string) => `- ${i}`), "");
    out.push(...numbered(x.schritte ?? []), "");
    if (truthy(x.haltbar)) out.push(`*${x.haltbar}*`, "");
  }
  out.push(`## ${t.list}`, "");
  for (const g of w.einkauf) {
    out.push(`### ${g.bereich}`, "", "| | Artikel | Preis | |", "|---|---|---|---|");
    for (const it of g.items) {
      out.push(`| ${it.anz} × | ${it.name}${truthy(it.laden) ? " · " + it.laden : ""} | `
        + `${fmtFixed(it.anz * it.preis, 2)} ${cur} | ${truthy(it.a) ? t.offer : t.est} |`);
    }
    out.push("");
  }
  if (truthy(w.vorrat)) out.push(`**${t.pantry}:** ` + w.vorrat.join(", "), "");
  if (truthy(w.nicht_kaufen)) out.push(`**${t.dont}:** ` + w.nicht_kaufen.join("; "), "");
  out.push(`## ${t.need}`, "", ...w.geraete.map((g: string) => `- ${g}`), "", `## ${t.steps}`, "", "| | | ⏱ |", "|---|---|---|");
  for (const s of w.prep) {
    out.push(`| ${truthy(s.neben) ? "↳" : s.t} | ${step_cell(s)} | ${truthy(s.timer) ? String(s.timer) + " min" : ""} |`);
  }
  out.push(...daily(w, t));
  if (truthy(w.lagerung)) out.push("", `## ${t.store}`, "", w.lagerung);
  out.push("", `## ${t.why}`, "", ...w.warum.map((x: Obj) => `- **${x.titel}:** ${x.text}`));
  out.push("", `## ${t.fb}`, "", ...numbered(w.feedback), "");
  return out.join("\n");
}

/** Text cell of a prep step: `**titel** — text`; an important step is bold as a whole. */
function step_cell(s: Obj): string {
  if (!truthy(s.titel)) return truthy(s.wichtig) ? `**${s.text}**` : s.text;
  return truthy(s.wichtig) ? `**${s.titel} — ${s.text}**` : `**${s.titel}** — ${s.text}`;
}

function daily(w: Obj, t: Record<string, string>): string[] {
  const out = ["", `## ${t.daily}`, ""];
  const vs: Obj[] = [...(w.vorbereitung ?? [])].sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0));
  for (const v of vs) {
    out.push(`- **${ddmm(fromIso(v.datum))}${truthy(v.wann) ? " · " + v.wann : ""}:** ${v.text}`);
  }
  for (const r of w.rezepte) {
    const z = truthy(r.zusammenbau) ? r.zusammenbau : {};
    out.push(`- **${r.titel} ${t.assemble}** (${z.wann ?? r.slot}${truthy(z.min) ? ", " + z.min + " " + t.min : ""}): ` + (r.anrichten ?? []).join(" → "));
  }
  return out;
}
