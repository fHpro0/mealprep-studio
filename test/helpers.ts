// Shared test helpers: fixtures written by the one-off Python golden script, a fixed clock,
// a fake network (fetch) and a fake `claude` process. Nothing here touches the real network.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as agent from "../src/agent.ts";
import { clock, dumps, type Obj } from "../src/py.ts";
import * as images from "../src/images.ts";

export const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fixture = (name: string): any => JSON.parse(fs.readFileSync(path.join(FX, name + ".json"), "utf-8"));

/** 2026-10-14 10:30:45 local — a Wednesday, same as the Python golden run. */
export function fixClock(y = 2026, m = 10, d = 14, h = 10, mi = 30, s = 45): void {
  clock.now = () => new Date(y, m - 1, d, h, mi, s);
}

/** Deep-equal AND same key order (the original wrote dicts in insertion order). */
export function sameJson(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.parse(dumps(actual));
  assert.deepStrictEqual(a, expected, msg);
  assert.equal(JSON.stringify(a), JSON.stringify(expected), msg + " (key order)");
}

export const tmpDir = (prefix = "mps-"): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const copyDir = (src: string, dest: string) => fs.cpSync(src, dest, { recursive: true });

/** Same encoding as gen.py's snapshot(): .json parsed, .md/.toml/.txt text, everything else a sha256. */
export function snapshot(root: string): Record<string, any> {
  const snap: Record<string, any> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const rel = path.relative(root, full).split(path.sep).join("/");
      const data = fs.readFileSync(full);
      if (e.name.endsWith(".json")) snap[rel] = JSON.parse(data.toString("utf-8"));
      else if (/\.(md|toml|txt)$/.test(e.name)) snap[rel] = data.toString("utf-8");
      else snap[rel] = "sha256:" + crypto.createHash("sha256").update(data).digest("hex");
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(snap).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function delta(prev: Record<string, any>, cur: Record<string, any>) {
  const changed: Record<string, any> = {};
  for (const [k, v] of Object.entries(cur)) if (JSON.stringify(prev[k]) !== JSON.stringify(v)) changed[k] = v;
  return { changed, removed: Object.keys(prev).filter((k) => !(k in cur)).sort() };
}

// ---- fake network ------------------------------------------------------------------------------
export interface Recorded { url: string; headers: Record<string, string> }
export function installFakeNet(net: Obj) {
  const original = globalThis.fetch;
  const hits: Record<string, number> = {};
  const requests: Recorded[] = [];
  const sleeps: number[] = [];
  const oldTiming = { ...images.timing };
  images.timing.gap = 0;
  images.timing.sleep = async (ms: number) => { if (ms > 0) sleeps.push(ms / 1000); };
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    requests.push({ url, headers: Object.fromEntries(Object.entries<string>(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
    assert.ok(init.signal, "every request must carry a timeout signal");
    const seq = net[url];
    assert.ok(seq, "unexpected network request (not in the golden run): " + url);
    const r = seq[Math.min(hits[url] ?? 0, seq.length - 1)];
    hits[url] = (hits[url] ?? 0) + 1;
    if (r.status === "neterror") throw Object.assign(new TypeError("fetch failed"), { cause: { message: "Name or service not known" } });
    return new Response(r.status >= 400 || r.status === 204 ? null : Buffer.from(r.body, "base64"), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return {
    /** requests (and retry sleeps) since the last call, sorted like gen.py's take_net() */
    take() {
      const out = { requests: [...requests].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)), sleeps: [...sleeps] };
      requests.length = 0; sleeps.length = 0;
      return out;
    },
    reset() { for (const k of Object.keys(hits)) delete hits[k]; },
    restore() { globalThis.fetch = original; Object.assign(images.timing, oldTiming); },
  };
}

export function assertNet(actual: { requests: Recorded[]; sleeps: number[] }, golden: { requests: Obj[]; sleeps: number[] }, msg = "") {
  assert.deepStrictEqual(actual.requests.map((r) => r.url), golden.requests.map((r: Obj) => r.url), msg + " urls");
  assert.deepStrictEqual(actual.requests.map((r) => r.headers), golden.requests.map((r: Obj) => r.headers), msg + " headers");
  assert.deepStrictEqual(actual.sleeps, golden.sleeps, msg + " sleeps");
}

// ---- fake claude -------------------------------------------------------------------------------
export interface Call { args: string[]; cwd: string; timeout: number }
export function installFakeClaude(replies: (string | Error)[]) {
  const original = agent.runner.exec;
  const calls: Call[] = [];
  agent.runner.exec = async (cmd, args, opts) => {
    calls.push({ args: [path.basename(cmd), ...args], cwd: opts.cwd, timeout: opts.timeoutMs / 1000 });
    const r = replies.shift();
    if (r === undefined) throw new Error("no canned claude reply left");
    if (r instanceof Error) throw r;
    return { stdout: r, stderr: "" };
  };
  return { calls, restore() { agent.runner.exec = original; } };
}

/** Like assert.equal for long texts, but reports only the first differing line. */
export function sameText(actual: string, expected: string, label = ""): void {
  if (actual === expected) return;
  const a = actual.split("\n"), e = expected.split("\n");
  const i = a.findIndex((l, n) => l !== e[n]);
  assert.fail(`${label}: first difference at line ${i + 1}\n  actual:   ${JSON.stringify(a[i])}\n  expected: ${JSON.stringify(e[i])}`);
}

/** The one known, harmless difference: JSON.parse cannot tell 5.0 from 5, so the ingredient table in the prompt shows "5 €/kg". */
export const dropFloatZero = (s: string): string => s.replace(/(\| \d+)\.0 €\/kg/g, "$1 €/kg");
