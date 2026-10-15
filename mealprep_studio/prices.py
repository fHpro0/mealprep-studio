"""Compare ingredient prices across every configured retailer near the household.

Only *offers* are public. Without an offer we fall back to the ingredient's regular price estimate
(`regulaer_eur_kg`, else `eur_kg`), multiplied by the retailer markup from household.toml.
Results are cached per shopping day, so a second round on the same day costs no network calls.
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import offers
from .calc import packs
from .config import Household


def _best_per_retailer(z: dict, rows: list[dict]) -> dict:
    best = {}
    for a in rows:
        name = f"{a.get('marke') or ''} {a['produkt']}".lower()
        if not re.search(z.get("muss", "."), name) or (z.get("nicht") and re.search(z["nicht"], name)):
            continue
        g, unit = a.get("grundpreis"), (a.get("einheit") or "").lower()
        if not g:
            continue
        if unit in ("kg", "l"):
            eur_kg = g
        elif unit in ("stk", "stück") and z.get("stueck_g"):
            eur_kg = g / (z["stueck_g"] / 1000)
        else:
            continue
        for lid in a["laden_id"].split(","):
            if lid not in best or eur_kg < best[lid]["eur_kg"]:
                best[lid] = {"laden": offers.RETAILERS.get(lid, a["laden"]),
                             "produkt": f"{a.get('marke') or ''} {a['produkt']}".strip(), "preis": a["preis"],
                             "eur_kg": round(eur_kg, 2), "bis": a.get("gueltig_bis"), "treue": a["treueprogramm"]}
    return best


def fetch_offers(hh: Household, db: dict, day: str, keys_needed: set[str] | None = None) -> dict:
    """{ingredient: {retailer_id: best offer}} — cached per day in the jobs folder."""
    o = hh.offers
    if not o["enabled"] or not o["zip"]:
        return {}
    cache_file: Path = hh.paths["jobs"] / f"offers-{o['zip']}-{day}.json"
    cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}
    todo = [k for k in (keys_needed or db.keys()) if k in db and db[k].get("suche") and k not in cache]
    if todo:
        try:
            api_keys = offers.get_keys()
        except offers.OffersError:
            return cache

        def one(k):
            try:
                return k, _best_per_retailer(db[k], offers.search(db[k]["suche"], o["zip"], api_keys, day, o["retailers"]))
            except offers.OffersError:
                return k, None

        with ThreadPoolExecutor(8) as ex:
            for k, best in ex.map(one, todo):
                if best is not None:
                    cache[k] = best
        cache_file.write_text(json.dumps(cache, ensure_ascii=False))
    return cache


def compare(hh: Household, db: dict, round_: dict, day: str) -> dict | None:
    """Price file for one round (what the web app uses for the 'where to shop' view)."""
    o = hh.offers
    if not o["enabled"]:
        return None
    keys = {l["zutat"] for k in round_["kandidaten"] for l in k.get("berechnet", {}).get("einkaufsliste", [])}
    found = fetch_offers(hh, db, day, keys)
    stores = o["retailers"] or sorted({lid for v in found.values() for lid in v})
    return {
        "stichtag": day, "plz": o["zip"], "laeden": {l: offers.RETAILERS.get(l, l) for l in stores},
        "aufschlag": o["markup"], "zweiter_laden_ab": o["second_store_min_saving"],
        "zutaten": {k: {"name": db[k]["name"], "standard_eur_kg": db[k]["eur_kg"],
                        "regulaer_eur_kg": db[k].get("regulaer_eur_kg", db[k]["eur_kg"]), "pack_g": db[k]["pack_g"],
                        "angebote": {l: v for l, v in found.get(k, {}).items() if l in stores}}
                    for k in sorted(keys) if k in db},
    }


def deals_digest(hh: Household, db: dict, day: str, limit: int = 25) -> str:
    """Short text for the planning prompt: ingredients that are clearly cheaper this week."""
    found = fetch_offers(hh, db, day)
    lines = []
    for k, per_store in found.items():
        if not per_store:
            continue
        lid, best = min(per_store.items(), key=lambda kv: kv[1]["eur_kg"])
        regular = db[k].get("regulaer_eur_kg", db[k]["eur_kg"])
        if best["eur_kg"] < regular * 0.9:
            lines.append((best["eur_kg"] / regular, f"- {k}: {best['eur_kg']:.2f}/kg at {best['laden']} "
                                                   f"(regular ~{regular:.2f}) until {best['bis']}"))
    lines.sort()
    return "\n".join(l for _, l in lines[:limit]) or "(no notable offers)"


def plan_stores(prices: dict | None, items: list[dict], min_saving: float) -> dict:
    """Pick one store, or two if that saves at least `min_saving`. Returns {stores, total, rows}."""
    def price_in(store, it):
        p = (prices or {}).get("zutaten", {}).get(it["zutat"])
        base = (p["regulaer_eur_kg"] if p else it["eur_kg"]) * (prices or {}).get("aufschlag", {}).get(store, 1)
        a = (p or {}).get("angebote", {}).get(store)
        return (a["eur_kg"], a) if a and a["eur_kg"] < base else (base, None)

    def cost(stores):
        rows, total = [], 0.0
        for it in items:
            if it["laden"] == "Vorrat":
                continue
            best = min(((price_in(s, it), s) for s in stores), key=lambda x: x[0][0])
            (eur_kg, offer), store = best
            n = packs(it["g"], it["pack_g"])
            eur = round(n * it["pack_g"] / 1000 * eur_kg, 2)
            total += eur
            rows.append({**it, "packungen": int(n), "eur": eur, "laden_plan": store, "angebot": offer})
        return total, rows

    if not prices:
        total, rows = cost([None])
        return {"stores": [], "total": round(total, 2), "rows": rows}
    stores = list(prices["laeden"])
    singles = sorted(((cost([s]), [s]) for s in stores), key=lambda x: x[0][0])
    (best_total, best_rows), best_stores = singles[0]
    for i, a in enumerate(stores):
        for b in stores[i + 1:]:
            (t, rows) = cost([a, b])
            if t < best_total - min_saving:
                best_total, best_rows, best_stores = t, rows, [a, b]
    return {"stores": best_stores, "total": round(best_total, 2), "rows": best_rows}
