"""One structured Claude call per action — no tools, no file browsing.

The server assembles everything Claude needs into one prompt and asks for JSON matching a schema
(`claude -p --json-schema`). Calculations, prices, images and file writes happen in Python.
That turns a multi-minute agent loop into a single answer (typically 20–60 s).
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from .config import REPO, Household

LANG = {"de": "German", "en": "English"}

_INGREDIENT = {
    "type": "object",
    "required": ["name", "kcal", "p", "kh", "eur_kg", "pack_g", "laden", "aisle"],
    "properties": {
        "name": {"type": "string"}, "kcal": {"type": "number"}, "p": {"type": "number"}, "kh": {"type": "number"},
        "eur_kg": {"type": "number"}, "pack_g": {"type": "number"}, "laden": {"type": "string"},
        "aisle": {"type": "string", "enum": ["chilled", "produce", "dry", "frozen", "pantry"]},
        "suche": {"type": "string"},
    },
}
_CANDIDATE = {
    "type": "object",
    "required": ["id", "slot"],
    "properties": {
        "id": {"type": "string", "description": "kebab-case; reuse the old id to keep or modify a dish"},
        "slot": {"type": "string"},
        "keep": {"type": "boolean", "description": "true = keep this existing dish unchanged; omit all other fields"},
        "titel": {"type": "string"}, "untertitel": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "aktiv": {"type": "integer", "description": "active prep minutes for this dish"},
        "pitch": {"type": "string"}, "warum": {"type": "string"}, "risiko": {"type": "string"},
        "antwort": {"type": "string", "description": "reply to the household's note on this dish, if any"},
        "bild_suche": {"type": "string", "description": "short English Wikimedia Commons query for a photo"},
        "rechnung": {
            "type": "object", "required": ["haupt"],
            "properties": {
                "haupt": {"type": "object", "additionalProperties": {"type": "number"}},
                "pro_portion": {"type": "object", "additionalProperties": {"type": "number"}},
            },
        },
    },
}
ROUND_SCHEMA = {
    "type": "object",
    "required": ["nachricht", "kandidaten"],
    "properties": {
        "nachricht": {"type": "string", "description": "1–4 sentences to the household: what changed and why"},
        "kandidaten": {"type": "array", "items": _CANDIDATE},
        "neue_zutaten": {"type": "object", "additionalProperties": _INGREDIENT},
    },
}
_STRS = {"type": "array", "items": {"type": "string"}}
_ZUTATEN = {"type": "array", "items": {"type": "object", "required": ["gruppe", "items"],
                                       "properties": {"gruppe": {"type": "string"}, "items": _STRS}}}
PLAN_SCHEMA = {
    "type": "object",
    "required": ["titel", "rezepte", "prep", "geraete", "warum", "feedback"],
    "properties": {
        "titel": {"type": "string", "description": "short catchy week title"},
        "rezepte": {"type": "array", "items": {
            "type": "object", "required": ["id", "zutaten", "schritte", "kipppunkt", "anrichten", "portion"],
            "properties": {
                "id": {"type": "string"},
                "kurz": {"type": "string", "description": "one-word label for prep steps, e.g. 'Gulasch'"},
                "zutaten": _ZUTATEN,
                "schritte": {"type": "array", "items": {"type": "string"},
                             "description": "how to cook this dish on its own: 3–6 short steps, one action each, amounts inside"},
                "kipppunkt": {"type": "string"}, "anrichten": _STRS,
                "portion": {"type": "object", "additionalProperties": _STRS,
                            "description": "per person id: what goes into one box/plate"},
                "reihenfolge": {"type": "boolean", "description": "true if salad/veg first, starch last matters"},
                "rechner_label": {"type": "string", "description": "e.g. 'cooked chicken, total weight' if the main part is portioned by weight"},
                "zusammenbau_wann": {"type": "string", "description": "when to assemble one portion, e.g. 'morning, for the lunch box' / 'evening, before eating'"},
                "zusammenbau_min": {"type": "integer", "description": "minutes per day to assemble"},
                "packen_titel": {"type": "string", "description": "'Einpacken' for a packed lunch, 'Auf den Teller' at home (household language)"},
                "packen": {"type": "array", "description": "the daily routine as 2–3 rows of verb → action, e.g. 'Nimm' → 'deine Dose', 'Leg drauf' → '5 Salatblätter, 6 Tomaten'. Very short.",
                           "items": {"type": "object", "required": ["wo", "was"],
                                     "properties": {"wo": {"type": "string", "description": "container, e.g. 'Große Dose', 'Becher', 'Form A/B', 'Salatkopf'"},
                                                    "was": {"type": "string"}}}},
                "essen": {"type": "array", "items": {"type": "string"}, "description": "0–2 tiny words-only steps at the table, e.g. 'umrühren', 'Reis zuletzt'"},
            }}},
        "vorbereitung": {"type": "array", "description": "everything outside the prep-day timeline, by day",
                         "items": {"type": "object", "required": ["tag", "text"],
                                   "properties": {"tag": {"type": "integer", "description": "day offset from the first eating day: -2 = two days before, 0 = first eating day"},
                                                  "wann": {"type": "string", "description": "e.g. 'after shopping', 'evening', 'before the prep starts'"},
                                                  "text": {"type": "string"}}}},
        "extras": {"type": "array",
                   "description": "sides or components eaten with more than one dish (e.g. a pickled salad for lunch and dinner) — "
                                  "written once here with the amounts for all portions, never repeated inside each recipe",
                   "items": {"type": "object", "required": ["id", "titel", "zutaten", "schritte"],
                             "properties": {"id": {"type": "string", "description": "kebab-case"},
                                            "titel": {"type": "string"}, "kurz": {"type": "string", "description": "one-word label"},
                                            "untertitel": {"type": "string"},
                                            "zutaten": _ZUTATEN, "schritte": _STRS,
                                            "haltbar": {"type": "string", "description": "e.g. '7–10 Tage im Kühlschrank'"}}}},
        "zusatz_einkauf": {"type": "array",
                           "description": "small items the recipes need that are neither in the calculated shopping list nor in the "
                                          "pantry file (vinegar, fresh herbs …). Never list what the pantry file already has.",
                           "items": {"type": "object", "required": ["name", "menge", "preis"],
                                     "properties": {"name": {"type": "string"},
                                                    "menge": {"type": "string", "description": "e.g. '1 Flasche (1 l)'"},
                                                    "preis": {"type": "number", "description": "rough estimate in the household currency"}}}},
        "prep": {"type": "array", "items": {
            "type": "object", "required": ["t", "titel", "text"],
            "properties": {"t": {"type": "string", "description": "offset like 0:00"},
                           "titel": {"type": "string", "description": "2–4 word headline, e.g. 'Bällchen formen'"},
                           "text": {"type": "string"},
                           "gericht": {"type": "string", "description": "id of the recipe or extra this step belongs to; empty for general steps (preheating, cleaning, packing)"},
                           "timer": {"type": "integer"}, "neben": {"type": "boolean"}, "wichtig": {"type": "boolean"}}}},
        "behaelter": {"type": "array", "description": "what goes into which container on prep day — max 3 rows, as few container types as possible",
                      "items": {"type": "object", "required": ["name", "inhalt"],
                                "properties": {"name": {"type": "string", "description": "e.g. 'Große Dose (750 ml)'"},
                                               "anzahl": {"type": "integer"}, "inhalt": {"type": "string"},
                                               "hinweis": {"type": "string", "description": "e.g. split per person"}}}},
        "geraete": _STRS, "vorrat": _STRS, "nicht_kaufen": _STRS, "feedback": _STRS,
        "warum": {"type": "array", "items": {"type": "object", "required": ["titel", "text"],
                                             "properties": {"titel": {"type": "string"}, "text": {"type": "string"}}}},
        "lagerung": {"type": "string"},
    },
}
FEEDBACK_SCHEMA = {
    "type": "object",
    "required": ["bewertungen", "antwort"],
    "properties": {
        "bewertungen": {"type": "array", "items": {"type": "object", "required": ["gericht", "note", "kommentar"],
                                                   "properties": {"gericht": {"type": "string"}, "note": {"type": "string"},
                                                                  "kommentar": {"type": "string"}}}},
        "gesperrt": _STRS, "regeln": _STRS,
        "antwort": {"type": "string", "description": "2–4 sentences back to the household"},
    },
}


def system_prompt(hh: Household) -> str:
    rules = (REPO / "prompts" / "rules.md").read_text(encoding="utf-8")
    return (f"You are the meal-prep planner of one household. Write every user-facing text in "
            f"{LANG.get(hh.language, hh.language)}. Reply only with the requested JSON.\n\n{rules}")


def _json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _read(p: Path, limit: int = 30000) -> str:
    if not p.exists():
        return "(none)"
    t = p.read_text(encoding="utf-8")
    return t if len(t) <= limit else "…(older part cut)…\n" + t[-limit:]


def household_context(hh: Household, db: dict, deals: str) -> str:
    persons = "\n".join(f"- {p['id']} ({p.get('name', '')}): {p['kcal']} kcal/day, protein ~{p.get('protein', '?')} g"
                        for p in hh.persons)
    meals = "\n".join(f"- slot `{m['id']}`: {m.get('label', m['id'])}{' — eaten COLD from a box' if m.get('cold') else ''}; "
                      + ", ".join(f"{p['id']} {round(hh.meal_target(m['id'], p['id']))} kcal" for p in hh.persons)
                      + f" → one dish = {hh.days * len(hh.persons)} portions ≈ "
                      f"{round(hh.days * sum(hh.meal_target(m['id'], p['id']) for p in hh.persons), -2):.0f} kcal in total"
                      for m in hh.meals)
    fixed = "\n".join(f"- {f['name']}: {f.get('kcal', 0)} kcal (not planned by you)" for f in hh.fixed_meals) or "(none)"
    ingr = "\n".join(f"{k} | {v['name']} | {v['kcal']}/{v['p']}/{v['kh']} | {v['eur_kg']} €/kg | {v.get('laden', '')}"
                     for k, v in sorted(db.items()))
    k = (_json(hh.paths["kitchen"]) or {}).get("items") or []
    kitchen = "\n".join(f"- {i['anz']}× {i['name']}" + (f" — {i['notiz']}" if i.get("notiz") else "") for i in k if i.get("anz")) \
        or "(not recorded — assume a normal home kitchen: 1 oven with 1 baking tray, 2 pots, 1 pan)"
    f = hh.freeze_days
    freeze = (f"Freezer: the portions for the last {f} eating day(s) (days {hh.days - f + 1}–{hh.days}) go into the freezer "
              f"on prep day, as soon as they are cool. Follow the freezer rules. Add `vorbereitung` entries to move "
              f"them to the fridge the evening before they are eaten.") if f else "Freezer: not used, everything is eaten fresh."
    return f"""# Household
Persons (one round = {hh.days} days, everything is cooked once on prep day):
{persons}
{freeze}
Meals you plan:
{meals}
Fixed meals:
{fixed}
Budget per round: {hh.budget} {hh.currency} for everything. Hard exclusions (never, not even traces): {', '.join(hh.exclusions) or '(none)'}

## Profile
{_read(hh.paths['profile'])}

## Feedback log (most important input)
{_read(hh.paths['feedback'])}

## Pantry
{_read(hh.paths['pantry'], 4000)}

## Kitchen equipment
Use ONLY this equipment and respect the notes (size, depth, capacity). Never plan more of an item than listed.
A shallow baking tray cannot hold liquid sauce: use a deep dish or pot, or a different technique.
{kitchen}

## Offers near the household this week
{deals}

## Ingredient database
Use ONLY these keys in `rechnung` (grams). The `rechnung` of one dish must add up to roughly the total kcal
above (±20 %). Low-calorie targets come from smaller portions, not from a recipe without fat or starch. Columns: key | name | kcal/protein/carbs per 100 g | price | store.
If you truly need another ingredient, add it under `neue_zutaten` with honest per-100 g values.
Spices, garlic, lemon juice, salt: leave them out of `rechnung` (mention them in the pitch/recipe).
{ingr}
"""


def run(hh: Household, prompt: str, schema: dict, cwd: Path) -> dict:
    a = hh.agent
    cmd = shutil.which(a["command"]) or str(Path.home() / ".local/bin" / a["command"])
    args = [cmd, "-p", prompt, "--output-format", "json", "--json-schema", json.dumps(schema),
            "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
            "--system-prompt", system_prompt(hh), "--model", a["model"]]
    if a.get("effort"):
        args += ["--effort", a["effort"]]
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=a["timeout_min"] * 60)
    try:
        res = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise RuntimeError((p.stderr or p.stdout or "no output from claude")[-600:])
    if res.get("is_error"):
        raise RuntimeError(str(res.get("result"))[-600:])
    out = res.get("structured_output")
    if out is None:  # older CLI versions: JSON in the text result
        txt = res.get("result", "")
        out = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
    out["_meta"] = {"dauer_ms": res.get("duration_ms"), "kosten_usd": res.get("total_cost_usd")}
    return out
