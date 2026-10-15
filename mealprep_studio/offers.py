"""Supermarket offers by postcode via marktguru.de (Germany and Austria only).

The public web app embeds its API keys in the page HTML; they are read fresh on every run because
marktguru rotates them. This is an unofficial interface — it may break or change at any time, and
you are responsible for using it in line with marktguru's terms. Disable with [offers] enabled = false.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

HOME_URL = "https://marktguru.de"
API_URL = "https://api.marktguru.de/api/v1/offers/search"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# marktguru retailer ids for the chains most people mean
RETAILERS = {
    "aldi-sued": "Aldi Süd", "aldi-nord": "Aldi Nord", "lidl": "Lidl", "netto-marken-discount": "Netto",
    "penny": "Penny", "norma": "Norma", "kaufland": "Kaufland", "rewe": "Rewe", "edeka": "Edeka",
    "globus": "Globus", "marktkauf": "Marktkauf", "hit": "HIT", "spar": "Spar", "billa": "Billa", "hofer": "Hofer",
}


class OffersError(RuntimeError):
    pass


def _fetch(url: str, headers: dict | None = None, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raise OffersError(f"HTTP {exc.code} from {urllib.parse.urlsplit(url).netloc}") from exc
    except urllib.error.URLError as exc:
        raise OffersError(f"network error: {exc.reason}") from exc


def get_keys() -> tuple[str, str]:
    html = _fetch(HOME_URL)
    for raw in reversed(re.findall(r'<script\s+type="application/json"[^>]*>(.*?)</script>', html, re.S)):
        try:
            cfg = json.loads(raw).get("config") or {}
        except json.JSONDecodeError:
            continue
        if cfg.get("apiKey") and cfg.get("clientKey"):
            return cfg["apiKey"], cfg["clientKey"]
    raise OffersError("no API keys found on marktguru.de — page layout changed; continue without offers")


def _covers(row: dict, day: str) -> bool:
    start, end = row.get("gueltig_von") or "", row.get("gueltig_bis") or ""
    return not ((start and day < start) or (end and day > end))


def _brand(offer: dict) -> str:
    name = ((offer.get("brand") or {}).get("name") or "").strip()
    unique = ((offer.get("brand") or {}).get("uniqueName") or "").strip().lower()
    if not name or "nobrand" in unique or "nobrand" in name.lower().replace(" ", ""):
        return ""
    return name


def _normalize(offer: dict) -> dict:
    advertisers = offer.get("advertisers") or []
    ranges = offer.get("validityDates") or []
    return {
        "produkt": (offer.get("product") or {}).get("name") or offer.get("description") or "?",
        "marke": _brand(offer),
        "laden": ", ".join(a.get("name", "") for a in advertisers),
        "laden_id": ",".join(a.get("uniqueName", "") for a in advertisers),
        "preis": offer.get("price"),
        "grundpreis": offer.get("referencePrice"),
        "einheit": (offer.get("unit") or {}).get("shortName") or "",
        "gueltig_von": (ranges[0].get("from") or "")[:10] if ranges else "",
        "gueltig_bis": (ranges[0].get("to") or "")[:10] if ranges else "",
        "treueprogramm": bool(offer.get("requiresLoyalityMembership")),
        "id": offer.get("id"),
    }


def search(query: str, zip_code: str, keys: tuple[str, str], day: str, retailers: list[str] | None = None,
           limit: int = 40) -> list[dict]:
    api_key, client_key = keys
    params = urllib.parse.urlencode({"as": "web", "q": query, "zipCode": zip_code, "limit": limit, "offset": 0})
    headers = {"x-apikey": api_key, "x-clientkey": client_key, "Accept": "application/json"}
    try:
        payload = json.loads(_fetch(f"{API_URL}?{params}", headers))
    except json.JSONDecodeError as exc:
        raise OffersError("marktguru answer was not JSON") from exc
    rows = [_normalize(o) for o in payload.get("results") or []]
    wanted = set(retailers or [])
    return [r for r in rows if _covers(r, day) and (not wanted or any(x in wanted for x in r["laden_id"].split(",")))]
