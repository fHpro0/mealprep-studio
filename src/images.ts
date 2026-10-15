// Freely licensed dish photos from Wikimedia Commons, with attribution.
import fs from "node:fs";
import path from "node:path";
import type { Household } from "./config.ts";
import { dumps, mkdirp, pyQuote, readText, type Obj } from "./py.ts";

const UA = { "User-Agent": "mealprep-studio/1.0 (https://github.com/fHpro0/mealprep-studio; personal meal planning)" };
const OK_LICENSES = ["cc0", "public domain", "pdm", "cc by", "cc-by"];
/** Commons rate-limits parallel bursts — one request at a time, GAP ms apart (tests zero these). */
export const timing = { gap: 1000, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
let chain: Promise<unknown> = Promise.resolve();
let last = 0;

class HttpError extends Error {
  code: number;
  retryAfter: string;
  constructor(code: number, retryAfter: string) {
    super(`HTTP Error ${code}`);
    this.code = code; this.retryAfter = retryAfter;
  }
}

async function getOnce(url: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await timing.sleep(Math.max(0, last + timing.gap - performance.now()));
    last = performance.now();
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const e = new HttpError(res.status, res.headers.get("Retry-After") ?? "");
    if (![429, 503].includes(e.code) || attempt === 5) throw e;
    await timing.sleep(/^\d+$/.test(e.retryAfter) ? Math.min(Number(e.retryAfter), 60) * 1000 : 3 * 2 ** attempt * 1000);
  }
  throw new Error("unreachable");
}

export function _get(url: string): Promise<Buffer> {
  const run = chain.then(() => getOnce(url));
  chain = run.catch(() => {});
  return run;
}

const STOP = new Set(["with", "and", "in", "on", "of", "the", "a", "mit", "und", "im", "auf"]);

export async function search(query: string): Promise<Obj[]> {
  const url = "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search"
    + "&gsrnamespace=6&gsrlimit=30&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600"
    + "&gsrsearch=" + pyQuote(query + " filetype:bitmap");
  const pages: Obj = JSON.parse((await _get(url)).toString("utf-8")).query?.pages ?? {};
  const hits: Obj[] = [];
  for (const p of Object.values<Obj>(pages).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
    const ii = p.imageinfo[0];
    const lic: string = ii.extmetadata?.LicenseShortName?.value ?? "";
    const words = (query.toLowerCase().match(/[a-zäöüß]+/g) ?? []).filter((w) => !STOP.has(w) && w.length > 2);
    const title = p.title.toLowerCase();
    if (words.length && !words.some((w) => title.includes(w.replace(/s+$/, "")))) continue;
    if (ii.width >= 800 && ii.width >= ii.height && OK_LICENSES.some((l) => lic.toLowerCase().startsWith(l))) {
      hits.push({
        title: p.title.replace(/^File:/, ""), thumb: ii.thumburl, license: lic,
        license_url: ii.extmetadata.LicenseUrl?.value ?? "",
        creator: (ii.extmetadata.Artist?.value ?? "").replace(/<[^>]+>/g, "").trim(),
        source_url: ii.descriptionurl,
      });
    }
  }
  return hits;
}

/** Download hit number `nr` for `query` to images/<rel_path>.
 * Returns the credit incl. the final relative `file`, or null. */
export async function fetch_(hh: Household, query: string, relPath: string, nr = 1): Promise<Obj | null> {
  const words = query.split(/\s+/).filter(Boolean);
  let hits: Obj[] = [];
  // specific first, then shorter: "roasted chicken potatoes yogurt" → "roasted chicken potatoes" → "roasted chicken"
  for (const q of new Set([query, words.slice(0, 3).join(" "), words.slice(0, 2).join(" ")])) {
    try {
      hits = await search(q);
    } catch {
      continue;
    }
    if (hits.length >= nr) break;
  }
  if (hits.length < nr) return null;
  const hit = hits[nr - 1];
  const data = await _get(hit.thumb);
  const stem = relPath.replace(/\.[^.]*$/, ""); // rsplit(".", 1)[0]
  // shortcut: photos are stored as downloaded, no WebP conversion; add sharp if size becomes a problem
  relPath = stem + ".jpg";
  const out = path.join(hh.paths.images, relPath);
  mkdirp(path.dirname(out));
  fs.writeFileSync(out, data);
  const base = path.basename(stem);
  for (const f of fs.readdirSync(path.dirname(out))) { // drop the previous photo of this dish
    const old = path.join(path.dirname(out), f);
    if (f.startsWith(base + ".") && old !== out) {
      fs.unlinkSync(old);
      set_credit(hh, path.relative(hh.paths.images, old).split(path.sep).join("/"), null);
    }
  }
  const credit: Obj = {};
  for (const k of ["title", "creator", "license", "license_url", "source_url"]) credit[k] = hit[k];
  Object.assign(credit, { query, nr, file: relPath });
  set_credit(hh, relPath, credit);
  return credit;
}

export function set_credit(hh: Household, relPath: string, credit: Obj | null): void {
  const f = path.join(hh.paths.images, "credits.json");
  const c: Obj = fs.existsSync(f) ? JSON.parse(readText(f)) : {};
  if (credit === null) delete c[relPath];
  else c[relPath] = credit;
  fs.writeFileSync(f, dumps(c, 1) + "\n", "utf-8");
}
