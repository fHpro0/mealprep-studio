"""Local web server: static app + household data + mailbox + background planner.

GET  /api/config                 household settings the app needs (no secrets)
GET  /api/index                  {"weeks": [...], "rounds": [...]}
GET  /api/status                 current/last job with phase
GET  /api/mailbox/<name>         mailbox file ({} if empty)
PUT  /api/mailbox/<name>         save mailbox file                   (PIN if configured)
GET  /api/kitchen                kitchen equipment inventory ({"items": []} if none)
PUT  /api/kitchen                save the inventory                  (PIN if configured)
POST /api/run   {action, id}     start an action in the background    (PIN if configured)
POST /api/image {round, id}      try the next photo for a candidate   (PIN if configured)
/rounds/*, /weeks/*, /img/*      household data files
everything else                  web app
"""
from __future__ import annotations

import hmac
import json
import re
import threading
import time
import traceback
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import actions, images
from .config import REPO, Household

NAME = re.compile(r"^[a-z0-9-]{1,60}$")
# Crawlers and link-preview bots never get content, even if the server is reachable from the internet.
BOTS = re.compile(r"bot\b|bot/|crawl|spider|slurp|scrap|facebookexternalhit|embedly|preview|whatsapp|telegram|"
                  r"discord|slack|skype|bingpreview|python-requests|curl/|wget|httpx|go-http|axios|"
                  r"gptbot|claudebot|ccbot|anthropic|perplexity|bytespider|amazonbot|applebot|yandex|baidu|semrush|ahrefs",
                  re.I)
NOINDEX = "noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate"
PHASES = ("offers", "thinking", "calculating", "prices", "images", "done", "error")


class Jobs:
    def __init__(self, hh: Household):
        self.hh, self.lock = hh, threading.Lock()
        self.file = hh.paths["jobs"] / "status.json"
        s = self.get()
        if s.get("running"):
            self.set(running=False, ok=False, phase="error", summary="Interrupted: server restarted.")

    def get(self) -> dict:
        try:
            return json.loads(self.file.read_text())
        except (OSError, json.JSONDecodeError):
            return {"running": False}

    def set(self, **kw) -> dict:
        s = {**self.get(), **kw, "updated": time.time()}
        self.file.write_text(json.dumps(s, ensure_ascii=False, indent=1))
        return s

    def start(self, action: str, ident: str) -> bool:
        if not self.lock.acquire(blocking=False):
            return False
        self.set(running=True, action=action, id=ident, phase="offers", start=actions.now(), end=None, ok=None,
                 summary="", seconds=None)
        threading.Thread(target=self._run, args=(action, ident), daemon=True).start()
        return True

    def _run(self, action: str, ident: str):
        t0 = time.time()
        try:
            summary = actions.ACTIONS[action](self.hh, ident, lambda phase: self.set(phase=phase))
            self.set(running=False, ok=True, phase="done", summary=summary)
        except Exception as e:  # shown to the household; details go to the log
            (self.hh.paths["jobs"] / "last-error.txt").write_text(traceback.format_exc())
            self.set(running=False, ok=False, phase="error", summary=str(e)[:600])
        finally:
            self.set(end=actions.now(), seconds=round(time.time() - t0))
            self.lock.release()


def make_handler(hh: Household, jobs: Jobs):
    web = REPO / "web"
    data_dirs = {"rounds": hh.paths["rounds"], "weeks": hh.paths["weeks"], "img": hh.paths["images"]}
    pin = str(hh.server["pin"])

    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(web), **kw)

        def translate_path(self, path):
            clean = path.split("?")[0].split("#")[0]
            first, _, rest = clean.lstrip("/").partition("/")
            if first in data_dirs and rest:
                p = (data_dirs[first] / urllib.parse.unquote(rest)).resolve()
                if data_dirs[first].resolve() in p.parents:
                    return str(p)
                return str(web / "__nope__")
            return super().translate_path(path)

        def end_headers(self):
            self.send_header("X-Robots-Tag", NOINDEX)
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            if getattr(self, "path", "/").split("?")[0].endswith((".json", ".html", ".js", ".css", "/")) or getattr(self, "path", "").startswith("/api/"):
                self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def reply(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def body(self) -> dict:
            n = int(self.headers.get("Content-Length", 0))
            if n > 200_000:
                raise ValueError("too large")
            return json.loads(self.rfile.read(n) or b"{}")

        def authorized(self) -> bool:
            return not pin or hmac.compare_digest(self.headers.get("X-Pin", ""), pin)

        def mailbox_path(self) -> Path:
            name = self.path.split("/api/mailbox/", 1)[1].split("?")[0].removesuffix(".json")
            if not NAME.match(name):
                raise ValueError("bad name")
            return hh.paths["mailbox"] / f"{name}.json"

        def is_bot(self) -> bool:
            return bool(BOTS.search(self.headers.get("User-Agent", "")))

        def do_GET(self):
            p = self.path.split("?")[0]
            if p == "/robots.txt":
                return super().do_GET()
            if self.is_bot() and not hh.server.get("allow_bots"):
                return self.reply(403, {"error": "private"})
            if p == "/api/config":
                return self.reply(200, hh.public())
            if p == "/api/index":
                return self.reply(200, {"weeks": actions.ids(hh.paths["weeks"]), "rounds": actions.ids(hh.paths["rounds"])})
            if p == "/api/status":
                return self.reply(200, jobs.get())
            if p == "/api/kitchen":
                return self.reply(200, actions.read(hh.paths["kitchen"], {"items": []}))
            if p.startswith("/api/mailbox/"):
                try:
                    f = self.mailbox_path()
                except ValueError as e:
                    return self.reply(400, {"error": str(e)})
                return self.reply(200, json.loads(f.read_text()) if f.exists() else {})
            return super().do_GET()

        def do_PUT(self):
            if self.path.split("?")[0] == "/api/kitchen":
                if not self.authorized():
                    return self.reply(401, {"error": "pin"})
                try:
                    data = kitchen_valid(self.body())
                except (ValueError, json.JSONDecodeError) as e:
                    return self.reply(400, {"error": str(e)})
                data["aktualisiert"] = actions.now()
                actions.write(hh.paths["kitchen"], data)
                return self.reply(200, {"ok": True, "aktualisiert": data["aktualisiert"]})
            if not self.path.startswith("/api/mailbox/"):
                return self.reply(404, {})
            if not self.authorized():
                return self.reply(401, {"error": "pin"})
            try:
                f, data = self.mailbox_path(), self.body()
            except (ValueError, json.JSONDecodeError) as e:
                return self.reply(400, {"error": str(e)})
            data["aktualisiert"] = actions.now()
            f.write_text(json.dumps(data, ensure_ascii=False, indent=1))
            return self.reply(200, {"ok": True, "aktualisiert": data["aktualisiert"]})

        def do_POST(self):
            if not self.authorized():
                return self.reply(401, {"error": "pin"})
            try:
                data = self.body()
            except (ValueError, json.JSONDecodeError) as e:
                return self.reply(400, {"error": str(e)})
            if self.path == "/api/run":
                action, ident = data.get("action"), str(data.get("id", ""))
                if action not in actions.ACTIONS or (ident and not NAME.match(ident)):
                    return self.reply(400, {"error": "unknown action or id"})
                if not jobs.start(action, ident):
                    return self.reply(409, {"error": "busy"})
                return self.reply(202, {"ok": True})
            if self.path == "/api/image":
                rid, cid = str(data.get("round", "")), str(data.get("id", ""))
                if not (NAME.match(rid) and NAME.match(cid)):
                    return self.reply(400, {"error": "bad id"})
                return self.reply(*swap_image(hh, rid, cid))
            return self.reply(404, {})

        def log_message(self, fmt, *args):
            if "/api/status" not in str(args[0] if args else ""):
                super().log_message(fmt, *args)

    return H


def kitchen_valid(data) -> dict:
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or len(items) > 100:
        raise ValueError("items: list of max 100")
    out = []
    for i in items:
        if not isinstance(i, dict):
            raise ValueError("item must be an object")
        name, anz, notiz = i.get("name"), i.get("anz"), i.get("notiz", "")
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ValueError("name: 1-80 characters")
        if type(anz) is not int or not 0 <= anz <= 99:
            raise ValueError("anz: integer 0-99")
        if not isinstance(notiz, str) or len(notiz) > 200:
            raise ValueError("notiz: max 200 characters")
        out.append({"name": name.strip(), "anz": anz, "notiz": notiz.strip()})
    return {"items": out}


def swap_image(hh: Household, rid: str, cid: str):
    path = hh.paths["rounds"] / f"{rid}.json"
    r = actions.read(path)
    if not r:
        return 404, {"error": "round"}
    c = next((k for k in r["kandidaten"] if k["id"] == cid), None)
    if not c or not c.get("bild_suche"):
        return 404, {"error": "no image query for this dish"}
    cf = hh.paths["images"] / "credits.json"
    credits = json.loads(cf.read_text() or "{}") if cf.exists() else {}
    current = c.get("bild", "").split("?")[0].removeprefix("img/")
    nr = credits.get(current, {}).get("nr", 0) + 1
    credit = images.fetch(hh, c["bild_suche"], f"kandidaten/{cid}", nr) or images.fetch(hh, c["bild_suche"], f"kandidaten/{cid}", 1)
    c["bild"] = f"img/{credit['file']}?v={int(time.time())}" if credit else ""
    actions.write(path, r)
    return 200, {"ok": bool(credit), "bild": c["bild"]}


def serve(hh: Household, port: int | None = None):
    jobs = Jobs(hh)
    port = port or int(hh.server["port"])
    httpd = ThreadingHTTPServer((hh.server["host"], port), make_handler(hh, jobs))
    return httpd, port
