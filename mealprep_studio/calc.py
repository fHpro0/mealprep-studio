"""Ingredient database + nutrition/portion/cost calculator.

A candidate carries a "rechnung" block:
    {"slot": "<meal id>", "haupt": {"<ingredient>": grams_total}, "pro_portion": {"<ingredient>": grams}}

"haupt" is cooked once for everybody and split by weight; "pro_portion" is the same for every
portion (rice, salad). The main quantities are scaled so every person hits their meal target —
quantities change, the target does not.
"""
from __future__ import annotations

import json
import math
import re

from .config import REPO, Household

PANTRY_STORES = {"vorrat", "pantry"}


def load_ingredients(hh: Household) -> dict:
    """Default database merged with the household's own, per key and per field: household fields win,
    fields the household entry omits (e.g. `aisle`) fall back to the default entry."""
    db = json.loads((REPO / "data" / "ingredients.json").read_text(encoding="utf-8"))
    own = hh.paths["ingredients"]
    if own.exists():
        for k, v in json.loads(own.read_text(encoding="utf-8")).items():
            if k.startswith("_"):
                continue
            db[k] = {**db[k], **v} if isinstance(db.get(k), dict) and isinstance(v, dict) else v
    return {k: v for k, v in db.items() if not k.startswith("_")}


def add_ingredients(hh: Household, new: dict) -> list[str]:
    """Persist agent-proposed ingredients into the household database. Never overwrites."""
    if not new:
        return []
    f = hh.paths["ingredients"]
    own = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    known = load_ingredients(hh)
    added = []
    for k, v in new.items():
        if k in known or k in own:
            continue
        own[k] = {**v, "quelle": v.get("quelle", "schaetzung")}
        added.append(k)
    if added:
        f.write_text(json.dumps(own, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return added


def is_pantry(z: dict) -> bool:
    return z.get("pantry") or str(z.get("laden", "")).lower() in PANTRY_STORES


def macros(db: dict, amounts: dict) -> dict:
    out = {"kcal": 0.0, "p": 0.0, "kh": 0.0}
    for k, g in amounts.items():
        if k not in db:
            raise KeyError(k)
        for m in out:
            out[m] += db[k][m] * g / 100
    return out


def packs(g: float, pack_g: float) -> int:
    return max(1, math.ceil(g / pack_g - 0.03))  # 3 % tolerance: 1,010 g from a 1 kg pack is one pack


def calculate(hh: Household, db: dict, cand: dict) -> dict:
    r = cand["rechnung"]
    slot = r.get("slot") or cand["slot"]
    persons = [p["id"] for p in hh.persons]
    n = hh.days
    fix = macros(db, r.get("pro_portion", {}))
    main = macros(db, r["haupt"])
    targets = {p: hh.meal_target(slot, p) for p in persons}
    needed = sum(n * (targets[p] - fix["kcal"]) for p in persons)
    factor = needed / main["kcal"] if main["kcal"] else 1
    amounts = {k: int(round(g * factor / 10) * 10) or g for k, g in r["haupt"].items()}
    main = macros(db, amounts)
    share = {p: (targets[p] - fix["kcal"]) / main["kcal"] for p in persons}
    per_person = {p: {m: round(share[p] * main[m] + fix[m]) for m in main} for p in persons}

    total = dict(amounts)
    for k, g in r.get("pro_portion", {}).items():
        total[k] = total.get(k, 0) + g * n * len(persons)
    shopping, cost = [], 0.0
    for k, g in total.items():
        z = db[k]
        name = z["name"] if hh.language == "de" else z.get(f"name_{hh.language}", z["name"])
        row = {"zutat": k, "name": name, "g": g, "pack_g": z["pack_g"], "eur_kg": z["eur_kg"],
               "laden": z.get("laden", ""), "quelle": z.get("quelle", ""), "aisle": z.get("aisle", "other")}
        if is_pantry(z):
            row.update(packungen=0, eur=0, laden="Vorrat")
        else:
            row["packungen"] = packs(g, z["pack_g"])
            row["eur"] = round(row["packungen"] * z["pack_g"] / 1000 * z["eur_kg"], 2)
            cost += row["eur"]
        shopping.append(row)

    warnings = []
    if abs(factor - 1) > 0.15:
        warnings.append(f"main quantities scaled {round((factor - 1) * 100):+d} %")
    cand["berechnet"] = {
        "mengen": amounts,
        "anteil": {p: round(s, 4) for p, s in share.items()},
        "makros": per_person,
        "kosten": {"einkauf": round(cost, 2)},
        "einkaufsliste": shopping,
        "skalierung": round(factor, 3),
        "warnungen": warnings,
    }
    cand["makros"] = per_person
    cand["kosten"] = round(cost, 2)
    return cand


def check_exclusions(hh: Household, db: dict, cand: dict) -> list[str]:
    """Hard safety net: excluded words in title, subtitle or ingredients ("ohne X"/"without X" is fine)."""
    text = " ".join(str(cand.get(k, "")) for k in ("titel", "untertitel")).lower()
    text += " " + " ".join(db.get(k, {}).get("name", k).lower() + " " + k
                           for part in ("haupt", "pro_portion") for k in cand.get("rechnung", {}).get(part, {}))
    hits = []
    for w in hh.exclusions:
        for m in re.finditer(re.escape(w), text):
            if not re.search(r"(ohne|without|kein|keine|no|free)[\s-]+\S*$", text[max(0, m.start() - 20):m.start()]):
                hits.append(w)
                break
    return hits
