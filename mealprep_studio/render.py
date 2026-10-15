"""Week plan JSON → printable Markdown (recipes, shopping list, equipment, prep timeline)."""
from __future__ import annotations

from .config import Household

T = {
    "de": {"shop": "Einkauf", "prep": "Prep", "days": "Essen", "recipes": "Rezepte", "kipp": "Hier kippt es",
           "plate": "Täglich anrichten", "portion": "Portion", "list": "Einkaufsliste", "sum": "Summe", "budget": "Budget",
           "pantry": "Vorher im Schrank nachsehen", "dont": "Nicht kaufen", "need": "Was benötigt wird",
           "steps": "Ablauf am Prep-Tag", "store": "Lagerung", "why": "Warum dieser Plan", "fb": "Feedback-Fragen",
           "for": "für alle", "portions": "Portionen", "offer": "Angebot", "est": "~",
           "daily": "Vorbereiten & täglich zusammenbauen", "assemble": "zusammenbauen", "min": "Min",
           "how": "So geht's"},
    "en": {"shop": "Shopping", "prep": "Prep", "days": "Eating", "recipes": "Recipes", "kipp": "Make-or-break step",
           "plate": "Plate it daily", "portion": "Portion", "list": "Shopping list", "sum": "Total", "budget": "Budget",
           "pantry": "Check the pantry first", "dont": "Don't buy", "need": "What you need",
           "steps": "Prep-day timeline", "store": "Storage", "why": "Why this plan", "fb": "Feedback questions",
           "for": "for all", "portions": "portions", "offer": "offer", "est": "~",
           "daily": "Prepare & assemble daily", "assemble": "assemble", "min": "min",
           "how": "How to cook"},
}


def week_markdown(hh: Household, w: dict) -> str:
    t = T.get(hh.language, T["en"])
    cur = hh.currency
    out = [f"# {w['titel']} — {w['zeitraum']}", "",
           f"**{t['shop']}:** {w['einkaufstag']} · **{t['prep']}:** {w['preptag']} · "
           f"**{t['sum']}:** {w['budget']['summe']:.2f} {cur} / {t['budget']} {w['budget']['limit']:.0f} {cur}", ""]
    out += ["| | " + " | ".join(r["titel"] for r in w["rezepte"]) + " | kcal/Tag |", "|---|" + "---|" * (len(w["rezepte"]) + 1)]
    fixed = (w.get("fruehstueck") or {}).get("kcal", 0)
    for pid, p in w["personen"].items():
        cells = [f"{r['makros'][pid]['kcal']} kcal · {r['makros'][pid]['p']} g P" for r in w["rezepte"]]
        out.append(f"| **{p['label']}** | " + " | ".join(cells) + f" | {fixed + sum(r['makros'][pid]['kcal'] for r in w['rezepte'])} |")
    out += ["", f"## {t['recipes']}", ""]
    for r in w["rezepte"]:
        out += [f"### {r['titel']} ({r['slot']}, {r['portionen']} {t['portions']})", "", f"*{r['untertitel']}*", ""]
        for g in r["zutaten"]:
            out += [f"**{g['gruppe']}**"] + [f"- {i}" for i in g["items"]] + [""]
        if r.get("schritte"):
            out += [f"**{t['how']}**"] + [f"{n}. {s}" for n, s in enumerate(r["schritte"], 1)] + [""]
        out += [f"> **{t['kipp']}:** {r['kipppunkt']}", "", f"**{t['plate']}**"]
        out += [f"{n}. {s}" for n, s in enumerate(r["anrichten"], 1)] + [""]
        for pid, lines in r.get("portion", {}).items():
            label = w["personen"].get(pid, {}).get("label", pid)
            out.append(f"- **{t['portion']} {label}:** " + "; ".join(lines))
        out.append("")
    for x in w.get("extras", []):
        out += [f"### {x['titel']}", ""]
        if x.get("untertitel"):
            out += [f"*{x['untertitel']}*", ""]
        for g in x.get("zutaten", []):
            out += [f"**{g['gruppe']}**"] + [f"- {i}" for i in g["items"]] + [""]
        out += [f"{n}. {s}" for n, s in enumerate(x.get("schritte", []), 1)] + [""]
        if x.get("haltbar"):
            out += [f"*{x['haltbar']}*", ""]
    out += [f"## {t['list']}", ""]
    for g in w["einkauf"]:
        out += [f"### {g['bereich']}", "", "| | Artikel | Preis | |", "|---|---|---|---|"]
        for it in g["items"]:
            out.append(f"| {it['anz']} × | {it['name']}{' · ' + it['laden'] if it.get('laden') else ''} | "
                       f"{it['anz'] * it['preis']:.2f} {cur} | {t['offer'] if it.get('a') else t['est']} |")
        out.append("")
    if w.get("vorrat"):
        out += [f"**{t['pantry']}:** " + ", ".join(w["vorrat"]), ""]
    if w.get("nicht_kaufen"):
        out += [f"**{t['dont']}:** " + "; ".join(w["nicht_kaufen"]), ""]
    out += [f"## {t['need']}", ""] + [f"- {g}" for g in w["geraete"]] + ["", f"## {t['steps']}", "", "| | | ⏱ |", "|---|---|---|"]
    for s in w["prep"]:
        out.append(f"| {'↳' if s.get('neben') else s['t']} | {_step_cell(s)} | "
                   f"{str(s['timer']) + ' min' if s.get('timer') else ''} |")
    out += _daily(w, t)
    if w.get("lagerung"):
        out += ["", f"## {t['store']}", "", w["lagerung"]]
    out += ["", f"## {t['why']}", ""] + [f"- **{x['titel']}:** {x['text']}" for x in w["warum"]]
    out += ["", f"## {t['fb']}", ""] + [f"{n}. {q}" for n, q in enumerate(w["feedback"], 1)] + [""]
    return "\n".join(out)


def _step_cell(s: dict) -> str:
    """Text cell of a prep step: `**titel** — text`; an important step is bold as a whole."""
    if not s.get("titel"):
        return f"**{s['text']}**" if s.get("wichtig") else s["text"]
    return f"**{s['titel']} — {s['text']}**" if s.get("wichtig") else f"**{s['titel']}** — {s['text']}"


def _daily(w: dict, t: dict) -> list[str]:
    import datetime as dt
    out = ["", f"## {t['daily']}", ""]
    for v in sorted(w.get("vorbereitung", []), key=lambda v: v["datum"]):
        d = dt.date.fromisoformat(v["datum"])
        out.append(f"- **{d:%d.%m.}{' · ' + v['wann'] if v.get('wann') else ''}:** {v['text']}")
    for r in w["rezepte"]:
        z = r.get("zusammenbau") or {}
        out.append(f"- **{r['titel']} {t['assemble']}** ({z.get('wann', r['slot'])}{', ' + str(z['min']) + ' ' + t['min'] if z.get('min') else ''}): "
                   + " → ".join(r.get("anrichten", [])))
    return out
