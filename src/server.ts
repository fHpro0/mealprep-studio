// Local web server: static app + household data + mailbox + background planner.
//
// GET  /api/config                 household settings the app needs (no secrets)
// GET  /api/index                  {"weeks": [...], "rounds": [...]}
// GET  /api/status                 current/last job with phase
// GET  /api/mailbox/<name>         mailbox file ({} if empty)
// PUT  /api/mailbox/<name>         save mailbox file                   (PIN if configured)
// GET  /api/kitchen                kitchen equipment inventory ({"items": []} if none)
// PUT  /api/kitchen                save the inventory                  (PIN if configured)
// POST /api/run   {action, id}     start an action in the background    (PIN if configured)
// POST /api/image {round, id}      try the next photo for a candidate   (PIN if configured)
// /rounds/*, /weeks/*, /img/*      household data files
// everything else                  web app
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import * as actions from "./actions.ts";
import { REPO, type Household } from "./config.ts";
import * as images from "./images.ts";
import { cpSlice, dumps, pyRound, pyStr, readText, resolveLoose, truthy, type Obj } from "./py.ts";

export const NAME = /^[a-z0-9-]{1,60}$/;
// Crawlers and link-preview bots never get content, even if the server is reachable from the internet.
export const BOTS = new RegExp(
  "bot\\b|bot/|crawl|spider|slurp|scrap|facebookexternalhit|embedly|preview|whatsapp|telegram|"
  + "discord|slack|skype|bingpreview|python-requests|curl/|wget|httpx|go-http|axios|"
  + "gptbot|claudebot|ccbot|anthropic|perplexity|bytespider|amazonbot|applebot|yandex|baidu|semrush|ahrefs", "i");
export const NOINDEX = "noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate";

export class Jobs {
  hh: Household;
  busy = false;
  file: string;
  constructor(hh: Household) {
    this.hh = hh;
    this.file = path.join(hh.paths.jobs, "status.json");
    if (this.get().running) this.set({ running: false, ok: false, phase: "error", summary: "Interrupted: server restarted." });
  }

  get(): Obj {
    try {
      return JSON.parse(readText(this.file));
    } catch {
      return { running: false };
    }
  }

  set(kw: Obj): Obj {
    const s = { ...this.get(), ...kw, updated: Date.now() / 1000 };
    fs.writeFileSync(this.file, dumps(s, 1), "utf-8");
    return s;
  }

  start(action: string, ident: string): boolean {
    if (this.busy) return false;
    this.busy = true;
    this.set({ running: true, action, id: ident, phase: "offers", start: actions.now(), end: null, ok: null, summary: "", seconds: null });
    void this.run(action, ident);
    return true;
  }

  async run(action: string, ident: string): Promise<void> {
    const t0 = Date.now() / 1000;
    try {
      const summary = await actions.ACTIONS[action](this.hh, ident, (phase) => this.set({ phase }));
      this.set({ running: false, ok: true, phase: "done", summary });
    } catch (e: any) { // shown to the household; details go to the log
      fs.writeFileSync(path.join(this.hh.paths.jobs, "last-error.txt"), String(e?.stack ?? e), "utf-8");
      this.set({ running: false, ok: false, phase: "error", summary: cpSlice(String(e?.message ?? e), 0, 600) });
    } finally {
      this.set({ end: actions.now(), seconds: pyRound(Date.now() / 1000 - t0) });
      this.busy = false;
    }
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".ico": "image/x-icon", ".xml": "application/xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

class BadRequest extends Error {}

const sha = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time compare (hashing first makes the length irrelevant). */
export const pinMatches = (given: string, pin: string): boolean => timingSafeEqual(sha(given), sha(pin));

function unquote(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function makeHandler(hh: Household, jobs: Jobs): http.RequestListener {
  const web = path.join(REPO, "web");
  const dataDirs: Record<string, string> = { rounds: hh.paths.rounds, weeks: hh.paths.weeks, img: hh.paths.images };
  const pin = String(hh.server.pin ?? "");

  /** Where a URL path lives on disk; anything outside web/ and the household data folders maps to a missing file. */
  const translatePath = (urlPath: string): string => {
    const clean = urlPath.split("?")[0].split("#")[0];
    const stripped = clean.replace(/^\/+/, "");
    const i = stripped.indexOf("/");
    const first = i < 0 ? stripped : stripped.slice(0, i), rest = i < 0 ? "" : stripped.slice(i + 1);
    if (Object.hasOwn(dataDirs, first) && rest) {
      const base = resolveLoose(dataDirs[first]);
      const rel = unquote(rest);
      if (rel.includes("\0")) return path.join(web, "__nope__");
      const p = resolveLoose(path.resolve(dataDirs[first], rel));
      return p.startsWith(base + path.sep) ? p : path.join(web, "__nope__");
    }
    const stack: string[] = [];
    for (const w of unquote(clean).split("/")) {
      if (w === "" || w === ".") continue;
      if (w === "..") stack.pop();
      else stack.push(w);
    }
    return path.join(web, ...stack.map((w) => w.replaceAll("\0", "_")));
  };

  const reply = (req: http.IncomingMessage, res: http.ServerResponse, code: number, body: Buffer | string, type: string, extra: Obj = {}) => {
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    const p = (req.url ?? "/").split("?")[0];
    res.writeHead(code, {
      ...(type ? { "Content-Type": type } : {}), "Content-Length": buf.length, Connection: "close", ...extra,
      "X-Robots-Tag": NOINDEX, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      ...(/(\.json|\.html|\.js|\.css|\/)$/.test(p) || (req.url ?? "").startsWith("/api/") ? { "Cache-Control": "no-store" } : {}),
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  };
  const json = (req: http.IncomingMessage, res: http.ServerResponse, code: number, obj: any) =>
    reply(req, res, code, dumps(obj), "application/json; charset=utf-8");
  const error = (req: http.IncomingMessage, res: http.ServerResponse, code: number, message: string) =>
    reply(req, res, code, `<!DOCTYPE HTML><html lang="en"><head><meta charset="utf-8"><title>Error response</title></head>`
      + `<body><h1>Error response</h1><p>Error code: ${code}</p><p>Message: ${message}.</p></body></html>`, "text/html;charset=utf-8");

  const body = (req: http.IncomingMessage): Promise<any> => new Promise((resolve, reject) => {
    const n = Number.parseInt(req.headers["content-length"] ?? "0", 10);
    if (Number.isNaN(n)) return reject(new BadRequest("invalid Content-Length"));
    if (n > 200_000) return reject(new BadRequest("too large"));
    const chunks: Buffer[] = [];
    let got = 0;
    const finish = () => {
      try {
        const raw = Buffer.concat(chunks).subarray(0, n).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e: any) {
        reject(new BadRequest(e.message));
      }
    };
    if (n <= 0) return finish();
    req.on("data", (c: Buffer) => { chunks.push(c); got += c.length; if (got >= n) { req.pause(); finish(); } });
    req.on("end", () => { if (got < n) finish(); });
    req.on("error", reject);
  });

  const authorized = (req: http.IncomingMessage) => !pin || pinMatches(String(req.headers["x-pin"] ?? ""), pin);
  const isBot = (req: http.IncomingMessage) => BOTS.test(String(req.headers["user-agent"] ?? ""));

  const mailboxPath = (url: string): string => {
    const name = url.split("/api/mailbox/")[1].split("?")[0].replace(/\.json$/, "");
    if (!NAME.test(name)) throw new BadRequest("bad name");
    return path.join(hh.paths.mailbox, `${name}.json`);
  };

  const serveStatic = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "/";
    const urlPath = url.split("?")[0].split("#")[0];
    let file = translatePath(url);
    let st: fs.Stats | undefined;
    try { st = fs.statSync(file); } catch { /* missing */ }
    if (st?.isDirectory()) {
      if (!urlPath.endsWith("/")) {
        const q = url.indexOf("?");
        return reply(req, res, 301, "", "", { Location: urlPath + "/" + (q >= 0 ? url.slice(q) : "") });
      }
      const idx = ["index.html", "index.htm"].map((f) => path.join(file, f)).find((f) => fs.existsSync(f));
      if (!idx) return error(req, res, 404, "File not found"); // (the Python server listed the directory here)
      file = idx;
      st = fs.statSync(file);
    } else if (urlPath.trimEnd().endsWith("/")) {
      st = undefined; // "file.txt/" is not a file
    }
    if (!st?.isFile()) return error(req, res, 404, "File not found");
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const p = url.split("?")[0];
    res.writeHead(200, {
      "Content-Type": type, "Content-Length": st.size, "Last-Modified": st.mtime.toUTCString(), Connection: "close",
      "X-Robots-Tag": NOINDEX, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      ...(/(\.json|\.html|\.js|\.css|\/)$/.test(p) ? { "Cache-Control": "no-store" } : {}),
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  };

  const get = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "/";
    const p = url.split("?")[0];
    if (p === "/robots.txt") return serveStatic(req, res);
    if (isBot(req) && !truthy(hh.server.allow_bots)) return json(req, res, 403, { error: "private" });
    if (req.method === "HEAD") return serveStatic(req, res);
    if (p === "/api/config") return json(req, res, 200, hh.public());
    if (p === "/api/index") return json(req, res, 200, { weeks: actions.ids(hh.paths.weeks), rounds: actions.ids(hh.paths.rounds) });
    if (p === "/api/status") return json(req, res, 200, jobs.get());
    if (p === "/api/kitchen") return json(req, res, 200, actions.read(hh.paths.kitchen, { items: [] }));
    if (p.startsWith("/api/mailbox/")) {
      let f: string;
      try {
        f = mailboxPath(url);
      } catch (e) {
        if (e instanceof BadRequest) return json(req, res, 400, { error: e.message });
        throw e;
      }
      return json(req, res, 200, fs.existsSync(f) ? JSON.parse(readText(f)) : {});
    }
    return serveStatic(req, res);
  };

  const put = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "/";
    if (url.split("?")[0] === "/api/kitchen") {
      if (!authorized(req)) return json(req, res, 401, { error: "pin" });
      let data: Obj;
      try {
        data = kitchen_valid(await body(req));
      } catch (e) {
        if (e instanceof BadRequest) return json(req, res, 400, { error: e.message });
        throw e;
      }
      data.aktualisiert = actions.now();
      actions.write(hh.paths.kitchen, data);
      return json(req, res, 200, { ok: true, aktualisiert: data.aktualisiert });
    }
    if (!url.startsWith("/api/mailbox/")) return json(req, res, 404, {});
    if (!authorized(req)) return json(req, res, 401, { error: "pin" });
    let f: string, data: Obj;
    try {
      f = mailboxPath(url);
      data = await body(req);
      if (data === null || typeof data !== "object" || Array.isArray(data)) throw new BadRequest("body must be a JSON object");
    } catch (e) {
      if (e instanceof BadRequest) return json(req, res, 400, { error: e.message });
      throw e;
    }
    data.aktualisiert = actions.now();
    fs.writeFileSync(f, dumps(data, 1), "utf-8");
    return json(req, res, 200, { ok: true, aktualisiert: data.aktualisiert });
  };

  const post = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!authorized(req)) return json(req, res, 401, { error: "pin" });
    let data: Obj;
    try {
      data = await body(req);
      if (data === null || typeof data !== "object" || Array.isArray(data)) throw new BadRequest("body must be a JSON object");
    } catch (e) {
      if (e instanceof BadRequest) return json(req, res, 400, { error: e.message });
      throw e;
    }
    if (req.url === "/api/run") {
      const action = data.action, ident = Object.hasOwn(data, "id") ? pyStr(data.id) : "";
      if (typeof action !== "string" || !Object.hasOwn(actions.ACTIONS, action) || (ident && !NAME.test(ident))) {
        return json(req, res, 400, { error: "unknown action or id" });
      }
      if (!jobs.start(action, ident)) return json(req, res, 409, { error: "busy" });
      return json(req, res, 202, { ok: true });
    }
    if (req.url === "/api/image") {
      const rid = Object.hasOwn(data, "round") ? pyStr(data.round) : "", cid = Object.hasOwn(data, "id") ? pyStr(data.id) : "";
      if (!(NAME.test(rid) && NAME.test(cid))) return json(req, res, 400, { error: "bad id" });
      const [code, obj] = await swap_image(hh, rid, cid);
      return json(req, res, code, obj);
    }
    return json(req, res, 404, {});
  };

  return (req, res) => {
    res.on("finish", () => {
      if (!(req.url ?? "").includes("/api/status")) {
        console.error(`${req.socket.remoteAddress} - - [${new Date().toString().slice(0, 24)}] "${req.method} ${req.url} HTTP/${req.httpVersion}" ${res.statusCode} -`);
      }
    });
    const run = async () => {
      if (req.method === "GET" || req.method === "HEAD") return get(req, res);
      if (req.method === "PUT") return put(req, res);
      if (req.method === "POST") return post(req, res);
      return error(req, res, 501, `Unsupported method ('${req.method}')`);
    };
    run().catch((e) => {
      console.error(e);
      if (!res.headersSent) json(req, res, 500, { error: "server error" });
      else res.destroy();
    });
  };
}

export function kitchen_valid(data: any): Obj {
  const items = data && typeof data === "object" && !Array.isArray(data) ? data.items : null;
  if (!Array.isArray(items) || items.length > 100) throw new BadRequest("items: list of max 100");
  const out: Obj[] = [];
  for (const i of items) {
    if (i === null || typeof i !== "object" || Array.isArray(i)) throw new BadRequest("item must be an object");
    const { name, anz } = i, notiz = i.notiz ?? "";
    if (typeof name !== "string" || !name.trim() || [...name].length > 80) throw new BadRequest("name: 1-80 characters");
    if (typeof anz !== "number" || !Number.isInteger(anz) || anz < 0 || anz > 99) throw new BadRequest("anz: integer 0-99");
    if (typeof notiz !== "string" || [...notiz].length > 200) throw new BadRequest("notiz: max 200 characters");
    out.push({ name: name.trim(), anz, notiz: notiz.trim() });
  }
  return { items: out };
}

export async function swap_image(hh: Household, rid: string, cid: string): Promise<[number, Obj]> {
  const p = path.join(hh.paths.rounds, `${rid}.json`);
  const r = actions.read(p);
  if (!truthy(r)) return [404, { error: "round" }];
  const c = r.kandidaten.find((k: Obj) => k.id === cid);
  if (!c || !truthy(c.bild_suche)) return [404, { error: "no image query for this dish" }];
  const cf = path.join(hh.paths.images, "credits.json");
  const credits: Obj = fs.existsSync(cf) ? JSON.parse(readText(cf) || "{}") : {};
  const current = String(c.bild ?? "").split("?")[0].replace(/^img\//, "");
  const nr = (credits[current]?.nr ?? 0) + 1;
  const credit = (await images.fetch_(hh, c.bild_suche, `kandidaten/${cid}`, nr)) || (await images.fetch_(hh, c.bild_suche, `kandidaten/${cid}`, 1));
  c.bild = credit ? `img/${credit.file}?v=${Math.floor(Date.now() / 1000)}` : "";
  actions.write(p, r);
  return [200, { ok: !!credit, bild: c.bild }];
}

/** Binds the server; resolves once it is listening. `port` falls back to [server] port. */
export async function serve(hh: Household, port?: number | null): Promise<{ httpd: http.Server; port: number }> {
  const jobs = new Jobs(hh);
  const p = port || Number(hh.server.port);
  const httpd = http.createServer(makeHandler(hh, jobs));
  await new Promise<void>((resolve, reject) => {
    httpd.once("error", reject);
    httpd.listen(p, String(hh.server.host), () => resolve());
  });
  return { httpd, port: p };
}
