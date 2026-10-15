"""The four actions behind the web buttons: new round, revise, plan, feedback."""
from __future__ import annotations

import datetime as dt
import json
import re
import shutil
import threading
from pathlib import Path

from . import agent, calc, images, prices, render
from .config import WEEKDAYS, Household

DAY_NAMES = {"de": ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"], "en": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]}
ID = re.compile(r"^\d{4}-\d{2}-\d{2}$")
BACKGROUND: list[threading.Thread] = []  # photo downloads still running after an action returns


# ---------- small helpers -------------------------------------------------------------------
def now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def read(p: Path, default=None):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def write(p: Path, data, backup_dir: Path | None = None) -> None:
    """Write JSON. If the file exists and backup_dir is given, keep a timestamped copy first."""
    if backup_dir and p.exists():
        backup_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, backup_dir / f"{p.stem}.{dt.datetime.now():%Y%m%d-%H%M%S}{p.suffix}")
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ids(folder: Path) -> list[str]:
    return sorted(f.stem for f in folder.glob("*.json") if ID.match(f.stem))


def fmt_day(hh: Household, d: dt.date) -> str:
    return f"{DAY_NAMES.get(hh.language, DAY_NAMES['en'])[d.weekday()]} {d:%d.%m.}"


def round_dates(hh: Household) -> dict:
    """Next round starts on the configured first eating day after the latest week/round."""
    s = hh.schedule
    latest = max(ids(hh.paths["weeks"]) + ids(hh.paths["rounds"]) or [dt.date.today().isoformat()])
    base = max(dt.date.fromisoformat(latest) + dt.timedelta(days=1), dt.date.today())
    first = base + dt.timedelta(days=(WEEKDAYS.index(s["first_day"]) - base.weekday()) % 7)
    def before(day):  # last <day> before `first`
        return first - dt.timedelta(days=(first.weekday() - WEEKDAYS.index(day)) % 7 or 7)
    shop, prep, last = before(s["shopping_day"]), before(s["prep_day"]), first + dt.timedelta(days=hh.days - 1)
    return {"id": first.isoformat(), "zeitraum": f"{fmt_day(hh, first)} – {fmt_day(hh, last)}{last:%Y}",
            "einkaufstag": fmt_day(hh, shop), "einkauf_iso": shop.isoformat(), "preptag": fmt_day(hh, prep)}


# ---------- candidate processing -------------------------------------------------------------
def process_candidates(hh: Household, db: dict, cands: list[dict], old: dict[str, dict]) -> tuple[list, list]:
    """Merge kept dishes, calculate, flag exclusions. Returns (candidates, notes)."""
    out, notes = [], []
    for c in cands:
        if c.get("keep") and c["id"] in old:
            out.append({**old[c["id"]], "neu": False, "antwort": c.get("antwort", "")})
            continue
        c.pop("keep", None)
        c.setdefault("rechnung", {}).setdefault("pro_portion", {})
        c["rechnung"]["slot"] = c["slot"]
        try:
            calc.calculate(hh, db, c)
        except KeyError as e:
            notes.append(f"dropped {c.get('titel', c['id'])}: unknown ingredient {e}")
            continue
        except ZeroDivisionError:
            notes.append(f"dropped {c.get('titel', c['id'])}: no main ingredients")
            continue
        bad = calc.check_exclusions(hh, db, c)
        if bad:
            notes.append(f"dropped {c.get('titel', c['id'])}: contains excluded {', '.join(bad)}")
            continue
        prev = old.get(c["id"])
        c["neu"] = prev is None or prev.get("rechnung", {}).get("haupt") != c["rechnung"]["haupt"]
        c["bild"] = prev.get("bild", "") if prev and prev.get("bild_suche") == c.get("bild_suche") else ""
        out.append(c)
    return out, notes


def fetch_images_async(hh: Household, round_path: Path, on_change) -> threading.Thread:
    """Fill in missing photos one by one after the round is already visible."""
    def work():
        r = read(round_path)
        for c in r["kandidaten"]:
            if c.get("bild") or not c.get("bild_suche"):
                continue
            credit = images.fetch(hh, c["bild_suche"], f"kandidaten/{c['id']}")
            if credit:
                cur = read(round_path)
                for k in cur["kandidaten"]:
                    if k["id"] == c["id"]:
                        k["bild"] = f"img/{credit['file']}"
                write(round_path, cur)
                on_change()
    t = threading.Thread(target=work, daemon=True)
    t.start()
    BACKGROUND.append(t)
    return t


def finish_round(hh: Household, db: dict, r: dict, path: Path, progress) -> None:
    progress("prices")
    pr = prices.compare(hh, db, r, r.get("einkauf_iso") or dt.date.today().isoformat())
    if pr:
        write(path.with_name(path.stem + "-preise.json"), pr)
    write(path, r)
    progress("images")
    fetch_images_async(hh, path, lambda: progress("images"))


def _offset(hh: Household, r: dict, key: str) -> str:
    """Day offset of shopping/prep day relative to the first eating day, as text for the prompt."""
    s = hh.schedule
    first = dt.date.fromisoformat(r["id"])
    day = s["shopping_day"] if key == "einkauf_iso" else s["prep_day"]
    back = (first.weekday() - WEEKDAYS.index(day)) % 7 or 7
    return f"tag = -{back}"


def _mailbox(hh: Household, rid: str) -> dict:
    return read(hh.paths["mailbox"] / f"{rid}.json", {}) or {}


def _brief(c: dict) -> dict:
    b = {k: c.get(k) for k in ("id", "slot", "titel", "untertitel", "tags", "aktiv", "pitch", "rechnung", "bild_suche")}
    f = (c.get("berechnet") or {}).get("skalierung")
    if f and not 0.8 <= f <= 1.25:  # the server had to stretch the recipe a lot: the amounts are off
        b["achtung"] = (f"rechnung is {'too small' if f > 1 else 'too big'}: the server had to scale the main part "
                        f"×{f}. If you change this dish, fix the amounts so it adds up to the total kcal.")
    return b


# ---------- actions ----------------------------------------------------------------------------
def new_round(hh: Household, _ident: str, progress) -> str:
    db = calc.load_ingredients(hh)
    d = round_dates(hh)
    progress("offers")
    deals = prices.deals_digest(hh, db, d["einkauf_iso"])
    n = hh.agent["candidates_per_meal"]
    progress("thinking")
    res = agent.run(hh, agent.household_context(hh, db, deals) + f"""
# Task
Propose a new round for {d['zeitraum']} (shopping {d['einkaufstag']}, prep {d['preptag']}).
Give exactly {n} candidates per slot ({', '.join(m['id'] for m in hh.meals)}), all clearly different from each
other, respecting every rule, exclusion and blocked category in the feedback log. Mix proven principles
with 1–2 new ideas per slot. Prefer this week's offers where they fit. Write `nachricht` as a short intro.
""", agent.ROUND_SCHEMA, hh.root)
    progress("calculating")
    calc.add_ingredients(hh, res.get("neue_zutaten", {}))
    db = calc.load_ingredients(hh)
    cands, notes = process_candidates(hh, db, res["kandidaten"], {})
    r = {"id": d["id"], "titel": d["zeitraum"], "zeitraum": d["zeitraum"], "einkaufstag": d["einkaufstag"],
         "einkauf_iso": d["einkauf_iso"], "preptag": d["preptag"], "status": "offen", "erstellt": now(),
         "nachricht": res["nachricht"], "verlauf": [{"zeit": now(), "von": "claude", "text": res["nachricht"]}],
         "kandidaten": cands, "hinweise": notes}
    finish_round(hh, db, r, hh.paths["rounds"] / f"{d['id']}.json", progress)
    return res["nachricht"]


def revise(hh: Household, rid: str, progress) -> str:
    db = calc.load_ingredients(hh)
    path = hh.paths["rounds"] / f"{rid}.json"
    r = read(path)
    mb = _mailbox(hh, rid)
    progress("offers")
    deals = prices.deals_digest(hh, db, r.get("einkauf_iso") or dt.date.today().isoformat())
    progress("thinking")
    res = agent.run(hh, agent.household_context(hh, db, deals) + f"""
# Current round
{json.dumps([_brief(c) for c in r['kandidaten']], ensure_ascii=False)}

# The household's reactions (mailbox)
{json.dumps({k: mb.get(k) for k in ('auswahl', 'reaktionen', 'wuensche', 'idee')}, ensure_ascii=False)}
Latest messages: {json.dumps(mb.get('nachrichten', [])[-3:], ensure_ascii=False)}

# Task
Revise the round. Return the full list again, {hh.agent['candidates_per_meal']} per slot:
- thumbs up (daumen 1) without a note → {{"id": "...", "slot": "...", "keep": true}}
- a note on a dish → same id, change the recipe accordingly, explain in `antwort`
- thumbs down → replace with a new dish (new id) that avoids the reason
- `wuensche` apply to the whole round; `idee` becomes its own candidate if it is a dish
- if a wish breaks an exclusion or blocked category, do not do it; say so in one sentence in `nachricht`
  and offer the closest safe alternative
- keep the currently selected dishes unless the household asked to change them
""", agent.ROUND_SCHEMA, hh.root)
    progress("calculating")
    calc.add_ingredients(hh, res.get("neue_zutaten", {}))
    db = calc.load_ingredients(hh)
    cands, notes = process_candidates(hh, db, res["kandidaten"], {c["id"]: c for c in r["kandidaten"]})
    # a dish Claude forgot to return is kept, unless the household gave it a thumbs down
    reac, ids_now = mb.get("reaktionen") or {}, {c["id"] for c in cands}
    for c in r["kandidaten"]:
        slot_full = sum(k["slot"] == c["slot"] for k in cands) >= hh.agent["candidates_per_meal"]
        if c["id"] not in ids_now and not slot_full and (reac.get(c["id"]) or {}).get("daumen") != -1:
            cands.append({**c, "neu": False})
    r["kandidaten"], r["hinweise"], r["nachricht"] = cands, notes, res["nachricht"]
    r.setdefault("verlauf", []).append({"zeit": now(), "von": "claude", "text": res["nachricht"]})
    finish_round(hh, db, r, path, progress)
    return res["nachricht"]


def plan(hh: Household, rid: str, progress) -> str:
    db = calc.load_ingredients(hh)
    path = hh.paths["rounds"] / f"{rid}.json"
    r = read(path)
    mb = _mailbox(hh, rid)
    chosen = [next((c for c in r["kandidaten"] if c["id"] == mb.get("auswahl", {}).get(m["id"])), None) for m in hh.meals]
    if None in chosen:
        raise RuntimeError("select one dish per meal first")
    progress("thinking")
    detail = [{**_brief(c), "mengen_gesamt_g": c["berechnet"]["mengen"], "pro_portion_g": c["rechnung"].get("pro_portion"),
               "warum": c.get("warum"), "risiko": c.get("risiko"), "makros": c["makros"]} for c in chosen]
    res = agent.run(hh, agent.household_context(hh, db, "(not needed)") + f"""
# Chosen dishes (amounts already calculated — use exactly these totals in `zutaten`)
{json.dumps(detail, ensure_ascii=False)}
Notes from the household: {json.dumps({k: mb.get(k) for k in ('reaktionen', 'idee')}, ensure_ascii=False)}

# Task
Write the cooking plan for prep day {r['preptag']} The household reads it on a phone while cooking:
short, scannable, one action per line, no prose.

Per recipe:
- `zutaten`: ingredient groups with amounts, incl. spices. Fresh produce (vegetables, fruit, herbs sold loose or
  by size) is ALWAYS in grams rounded to 50 g with the approximate count in brackets: "1,2 kg Salatgurken (ca. 3–4 Stück)",
  "500 g Zwiebeln (ca. 4)". Never a bare piece count for produce. Packaged goods stay whole packs
  ("2 Packungen Hack à 1 kg"), eggs are pieces ("3 Eier"), spices and oil in spoons. Everything else grams rounded to 10 g.
- `schritte`: how to cook this dish on its own, 3–6 steps, one action each, amounts inside (produce in grams, as above).
- `kipppunkt`: the one make-or-break step. `portion` per person id ({', '.join(p['id'] for p in hh.persons)}): what goes into one box.
- `zusammenbau_wann`, `zusammenbau_min`, `packen` (container → exact content, max 3 rows), `essen` (2–3 tiny steps).
A side eaten with more than one dish (e.g. a pickled salad) goes ONCE into `extras`, with the amounts for all
portions and its own steps. Never repeat it inside each recipe's `zutaten`.

`prep`: one combined timeline for everything, offsets from 0:00, about 10–16 steps. Each step is ONE action:
`titel` 2–4 words ("Bällchen formen"), `text` at most ~20 words incl. the amounts (produce in grams, as above), `gericht` = the recipe or
extra id. Timers in minutes, parallel work as `neben`, at most 3 steps `wichtig`. Use the oven in parallel.
`zusatz_einkauf`: everything the recipes need that is neither in the calculated shopping list nor in the pantry
file (vinegar, fresh herbs …), with a rough price; `menge` follows the produce rule too ("200 g Basilikum"). `vorrat`: only items the pantry file lists.
Also: `geraete` = equipment incl. containers, ONLY items from the kitchen equipment list (plus the household's own
containers), each with what it is used for ("Fettpfanne (2 cm Rand): Bällchen, Sauce erst nach dem Backen dazu"). Then: things not to buy, 3–4 "why" cards, 3–4 concrete feedback questions.
`vorbereitung`: every task OUTSIDE the prep timeline, as day offsets from the first eating day (shopping day is
{_offset(hh, r, 'einkauf_iso')}, prep day is {_offset(hh, r, 'prep_iso')}): storing meat after shopping, what to set out
or preheat before the prep starts, and freezer reminders (e.g. "evening of day 4: move the boxes for day 5 into the fridge"). No other mid-week tasks.
`behaelter`: what goes into which container on prep day, with counts and the split per person.
""", agent.PLAN_SCHEMA, hh.root)
    progress("calculating")
    week = build_week(hh, db, r, chosen, res)
    weeks, backups = hh.paths["weeks"], hh.paths["jobs"] / "backups"
    write(weeks / f"{rid}.json", week, backups)
    md = hh.paths["plans"] / f"woche-{rid}.md"
    if md.exists():
        backups.mkdir(parents=True, exist_ok=True)
        shutil.copy2(md, backups / f"{md.stem}.{dt.datetime.now():%Y%m%d-%H%M%S}.md")
    md.write_text(render.week_markdown(hh, week), encoding="utf-8")
    status, note = ("offen", "neu im Plan") if hh.language == "de" else ("open", "new in plan")
    append_ratings(hh, [(r["zeitraum"], c["titel"], status, note) for c in chosen])
    r["status"] = "geplant"
    r.setdefault("verlauf", []).append({"zeit": now(), "von": "claude",
                                        "text": f"Plan steht: {' + '.join(c['titel'] for c in chosen)} · {week['budget']['summe']:.2f} {hh.currency}"})
    write(path, r)
    return f"{week['titel']} — {week['budget']['summe']:.2f} {hh.currency}"


AISLES = {"chilled": "Kühlung", "produce": "Obst & Gemüse", "dry": "Konserven & Trocken", "frozen": "Tiefkühl", "other": "Sonstiges"}
AISLES_EN = {"chilled": "Chilled", "produce": "Produce", "dry": "Dry goods", "frozen": "Frozen", "other": "Other"}


def build_week(hh: Household, db: dict, r: dict, chosen: list[dict], res: dict) -> dict:
    pr = read(hh.paths["rounds"] / f"{r['id']}-preise.json")
    items: dict[str, dict] = {}
    for c in chosen:
        for l in c["berechnet"]["einkaufsliste"]:
            it = items.setdefault(l["zutat"], {**l, "g": 0})
            it["g"] += l["g"]
    store_plan = prices.plan_stores(pr, list(items.values()), hh.offers["second_store_min_saving"])
    names = AISLES if hh.language == "de" else AISLES_EN
    groups: dict[str, list] = {}
    for row in store_plan["rows"]:
        a = db.get(row["zutat"], {}).get("aisle") or row.get("aisle") or "other"
        sg = db.get(row["zutat"], {}).get("stueck_g")
        pcs = f" · ca. {max(1, round(row['g'] / sg))} {'Stück' if hh.language == 'de' else 'pcs'}" if a == "produce" and sg else ""
        groups.setdefault(names.get(a, a), []).append({
            "name": f"{row['name']} ({row['g']:,} g)".replace(",", "." if hh.language == "de" else ",") + pcs, "anz": row["packungen"],
            "preis": round(row["eur"] / row["packungen"], 2), "a": bool(row.get("angebot")),
            "laden": (pr or {}).get("laeden", {}).get(row.get("laden_plan"), "") if pr else row.get("laden", "")})
    by_id = {x["id"]: x for x in res["rezepte"]}
    rezepte = []
    for c, meal in zip(chosen, hh.meals):
        x = by_id.get(c["id"], {})
        rez = {"id": c["id"], "slot": meal.get("label", meal["id"]), "titel": c["titel"], "kurz": x.get("kurz", ""),
               "untertitel": c.get("untertitel", ""),
               "bild": c.get("bild", ""), "tags": c.get("tags", []), "aktiv": c.get("aktiv", 20), "portionen": hh.days * len(hh.persons),
               "makros": c["makros"], "zutaten": x.get("zutaten", []), "schritte": x.get("schritte", []),
               "kipppunkt": x.get("kipppunkt", c.get("risiko", "")),
               "anrichten": x.get("anrichten", []), "portion": x.get("portion", {}), "reihenfolge": x.get("reihenfolge", False)}
        if x.get("rechner_label"):
            rez["rechner"] = {"label": x["rechner_label"], **c["berechnet"]["anteil"]}
        if x.get("zusammenbau_wann") or x.get("packen"):
            rez["zusammenbau"] = {"wann": x.get("zusammenbau_wann", ""), "min": x.get("zusammenbau_min"),
                                  "packen_titel": x.get("packen_titel", ""), "packen": x.get("packen", []), "essen": x.get("essen", [])}
        rezepte.append(rez)
    stores = [(pr or {}).get("laeden", {}).get(s, s) for s in store_plan["stores"]]
    einkauf = [{"bereich": k, "items": v} for k, v in groups.items()]
    extra_items = [{"name": f"{z['name']} ({z['menge']})", "anz": 1, "preis": round(float(z["preis"]), 2), "a": False, "laden": ""}
                   for z in res.get("zusatz_einkauf", [])]
    if extra_items:
        einkauf.append({"bereich": "Dazu kaufen" if hh.language == "de" else "Also buy", "items": extra_items})
    summe = round(store_plan["total"] + sum(i["preis"] for i in extra_items), 2)
    return {
        "id": r["id"], "titel": res["titel"], "zeitraum": r["zeitraum"],
        "einkaufstag": f"{r['einkaufstag']} · {' + '.join(stores) or '–'}", "preptag": f"{r['preptag']} · ~{sum(x['aktiv'] for x in rezepte) + 10} Min",
        "budget": {"summe": summe, "limit": hh.budget},
        "hero": next((x["bild"] for x in rezepte if x["bild"]), ""),
        "personen": {p["id"]: {"label": p.get("label", p["id"]), "wer": p.get("name", ""), "ziel": p["kcal"]} for p in hh.persons},
        "fruehstueck": ({"name": hh.fixed_meals[0]["name"], "text": hh.fixed_meals[0].get("text", ""),
                         "kcal": hh.fixed_meals[0].get("kcal", 0), "p": hh.fixed_meals[0].get("protein", 0),
                         "kh": hh.fixed_meals[0].get("carbs", 0)} if hh.fixed_meals else None),
        "rezepte": rezepte, "extras": res.get("extras", []),
        "einkauf": einkauf,
        "vorrat": res.get("vorrat", []) + [i["name"] for i in items.values() if i["laden"] == "Vorrat"],
        "nicht_kaufen": res.get("nicht_kaufen", []), "geraete": res["geraete"], "prep": res["prep"],
        "warum": res["warum"], "feedback": res["feedback"], "lagerung": res.get("lagerung", ""),
        "behaelter": res.get("behaelter", []),
        "vorbereitung": [{"datum": (dt.date.fromisoformat(r["id"]) + dt.timedelta(days=v["tag"])).isoformat(),
                          "wann": v.get("wann", ""), "text": v["text"]} for v in res.get("vorbereitung", [])],
        "erstellt": now(),
    }


def feedback(hh: Household, wid: str, progress) -> str:
    db = calc.load_ingredients(hh)
    week = read(hh.paths["weeks"] / f"{wid}.json")
    fb = _mailbox(hh, f"feedback-{wid}")
    progress("thinking")
    res = agent.run(hh, agent.household_context(hh, db, "(not needed)") + f"""
# The week that was cooked
{json.dumps({k: week.get(k) for k in ('zeitraum', 'titel')} | {'rezepte': [{k: x.get(k) for k in ('id', 'titel', 'untertitel')} for x in week['rezepte']], 'fragen': week.get('feedback')}, ensure_ascii=False)}

# The household's feedback
Structure: gerichte[dish id][person id] = {{note 1–10, tags (quick reactions), wieder (cook again?), kommentar}};
fakten = actual prep minutes, receipt total, hunger between meals, portion size; antworten = answers to the questions.
Persons: {', '.join(f"{p['id']} = {p.get('label', p['id'])}" for p in hh.persons)}
{json.dumps(fb, ensure_ascii=False)}

# Task
Turn this into log entries: one rating row per dish. `note` shows every person's score, e.g. "8/10 (Alex) · 6/10 (Sam)";
`kommentar` condenses tags, cook-again and comments in their words. Add one extra row with gericht "Woche" for the
facts (prep time vs. plan, spend vs. budget, hunger, portion size) if any were given.
Negative tags like "too dry", "mushy", "not filling", "not tolerated" are strong signals.
If something failed, derive the CATEGORY to block (not the single recipe) and/or a general rule — only if the
feedback really supports it, and never duplicate existing entries. Then answer the household in 2–4 sentences.
""", agent.FEEDBACK_SCHEMA, hh.root)
    progress("calculating")
    append_ratings(hh, [(week["zeitraum"], b["gericht"], b["note"], b["kommentar"]) for b in res["bewertungen"]])
    append_bullets(hh, r"gesperrt|blocked", res.get("gesperrt", []), "## Blocked — never suggest again")
    append_bullets(hh, r"regeln|rules", res.get("regeln", []), "## Rules")
    week["feedback_antwort"] = res["antwort"]
    week["feedback_ergebnis"] = {k: res.get(k, []) for k in ("bewertungen", "gesperrt", "regeln")} | {"zeit": now()}
    write(hh.paths["weeks"] / f"{wid}.json", week)
    return res["antwort"]


# ---------- feedback.md editing (append-only) -------------------------------------------------
def _sections(text: str):
    return [(m.start(), m.group(1)) for m in re.finditer(r"^#{2,3} (.+)$", text, re.M)]


def append_ratings(hh: Household, rows: list[tuple]) -> None:
    f = hh.paths["feedback"]
    text = f.read_text(encoding="utf-8") if f.exists() else ""
    new = "".join(f"| {w} | {d} | **{n}** | {c} |\n" for w, d, n, c in rows)
    secs = _sections(text)
    for i, (pos, title) in enumerate(secs):
        if re.search(r"bewertung|rating", title, re.I):
            end = secs[i + 1][0] if i + 1 < len(secs) else len(text)
            body = text[pos:end]
            last = max((m.end() for m in re.finditer(r"^\|.*\|[ \t]*$\n?", body, re.M)), default=None)
            if last is not None:
                insert = pos + last
                if not text[:insert].endswith("\n"):
                    new = "\n" + new
                f.write_text(text[:insert] + new + text[insert:], encoding="utf-8")
                return
    f.write_text(text.rstrip() + "\n\n## Ratings\n\n| Week | Dish | Score | Comment |\n|---|---|---|---|\n" + new,
                 encoding="utf-8")


def append_bullets(hh: Household, heading_re: str, bullets: list[str], fallback_heading: str) -> None:
    if not bullets:
        return
    f = hh.paths["feedback"]
    text = f.read_text(encoding="utf-8") if f.exists() else ""
    new = "".join(f"- {b} *(added {dt.date.today():%d.%m.%Y})*\n" for b in bullets)
    secs = _sections(text)
    for i, (pos, title) in enumerate(secs):
        if re.search(heading_re, title, re.I):
            end = secs[i + 1][0] if i + 1 < len(secs) else len(text)
            insert = pos + len(text[pos:end].rstrip()) + 1
            f.write_text(text[:insert] + new + text[insert:], encoding="utf-8")
            return
    f.write_text(text.rstrip() + f"\n\n{fallback_heading}\n\n" + new, encoding="utf-8")


ACTIONS = {"neue_runde": new_round, "ueberarbeiten": revise, "plan_erstellen": plan, "feedback_uebernehmen": feedback}
