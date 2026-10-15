"""Freely licensed dish photos from Wikimedia Commons, with attribution."""
from __future__ import annotations

import io
import urllib.error
import json
import re
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .config import Household

UA = {"User-Agent": "mealprep-studio/1.0 (https://github.com/fHpro0/mealprep-studio; personal meal planning)"}
OK_LICENSES = ("cc0", "public domain", "pdm", "cc by", "cc-by")
_lock = threading.Lock()  # Commons rate-limits parallel bursts — one request at a time
_last = [0.0]
GAP = 1.0  # seconds between two Commons requests


def _get(url: str) -> bytes:
    with _lock:
        for attempt in range(6):
            time.sleep(max(0.0, _last[0] + GAP - time.monotonic()))
            _last[0] = time.monotonic()
            try:
                return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
            except urllib.error.HTTPError as e:
                if e.code not in (429, 503) or attempt == 5:
                    raise
                wait = e.headers.get("Retry-After", "")
                time.sleep(min(int(wait), 60) if wait.isdigit() else 3 * 2 ** attempt)
        raise RuntimeError("unreachable")


STOP = {"with", "and", "in", "on", "of", "the", "a", "mit", "und", "im", "auf"}


def search(query: str) -> list[dict]:
    url = ("https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search"
           "&gsrnamespace=6&gsrlimit=30&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600"
           "&gsrsearch=" + urllib.parse.quote(query + " filetype:bitmap"))
    pages = json.loads(_get(url)).get("query", {}).get("pages", {})
    hits = []
    for p in sorted(pages.values(), key=lambda p: p.get("index", 0)):
        ii = p["imageinfo"][0]
        lic = ii.get("extmetadata", {}).get("LicenseShortName", {}).get("value", "")
        words = [w for w in re.findall(r"[a-zäöüß]+", query.lower()) if w not in STOP and len(w) > 2]
        title = p["title"].lower()
        if words and not any(w.rstrip("s") in title for w in words):
            continue
        if ii["width"] >= 800 and ii["width"] >= ii["height"] and lic.lower().startswith(OK_LICENSES):
            hits.append({"title": p["title"].removeprefix("File:"), "thumb": ii["thumburl"], "license": lic,
                         "license_url": ii["extmetadata"].get("LicenseUrl", {}).get("value", ""),
                         "creator": re.sub("<[^>]+>", "", ii["extmetadata"].get("Artist", {}).get("value", "")).strip(),
                         "source_url": ii["descriptionurl"]})
    return hits


def fetch(hh: Household, query: str, rel_path: str, nr: int = 1) -> dict | None:
    """Download hit number `nr` for `query` to images/<rel_path> (stored as .webp when Pillow is
    available, else the original JPEG). Returns the credit incl. the final relative `file`, or None."""
    words = query.split()
    hits = []
    # specific first, then shorter: "roasted chicken potatoes yogurt" → "roasted chicken potatoes" → "roasted chicken"
    for q in dict.fromkeys([query, " ".join(words[:3]), " ".join(words[:2])]):
        try:
            hits = search(q)
        except Exception:
            continue
        if len(hits) >= nr:
            break
    if len(hits) < nr:
        return None
    hit = hits[nr - 1]
    data = _get(hit["thumb"])
    stem = rel_path.rsplit(".", 1)[0]
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(data)).convert("RGB")
        im.thumbnail((1400, 1400))
        rel_path = stem + ".webp"
        out = hh.paths["images"] / rel_path
        out.parent.mkdir(parents=True, exist_ok=True)
        im.save(out, "WEBP", quality=78, method=6)
    except ImportError:  # Pillow is optional; Commons thumbs are already ≤1600 px JPEGs
        rel_path = stem + ".jpg"
        out = hh.paths["images"] / rel_path
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
    for old in out.parent.glob(Path(stem).name + ".*"):  # drop the previous photo of this dish
        if old != out:
            old.unlink()
            set_credit(hh, str(old.relative_to(hh.paths["images"])), None)
    credit = {k: hit[k] for k in ("title", "creator", "license", "license_url", "source_url")}
    credit["query"], credit["nr"], credit["file"] = query, nr, rel_path
    set_credit(hh, rel_path, credit)
    return credit


def set_credit(hh: Household, rel_path: str, credit: dict | None) -> None:
    f = hh.paths["images"] / "credits.json"
    with _lock:
        c = json.loads(f.read_text()) if f.exists() else {}
        if credit is None:
            c.pop(rel_path, None)
        else:
            c[rel_path] = credit
        f.write_text(json.dumps(c, ensure_ascii=False, indent=1) + "\n")
