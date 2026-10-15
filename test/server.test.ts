// HTTP API parity: the same request script is replayed against the TS server and must give the
// status codes, headers (security headers included) and JSON bodies the Python server gave.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import * as agent from "../src/agent.ts";
import * as config from "../src/config.ts";
import { cmd_init } from "../src/commands.ts";
import { dumps } from "../src/py.ts";
import { Jobs, NOINDEX, pinMatches, serve } from "../src/server.ts";
import { FX, assertNet, copyDir, fixClock, fixture, installFakeNet, sameJson, snapshot, tmpDir } from "./helpers.ts";

const KEEP = ["content-type", "content-length", "cache-control", "x-robots-tag", "referrer-policy", "x-content-type-options", "x-frame-options", "location"];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

function request(port: number, method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { ...headers, ...(body !== undefined ? { "Content-Length": Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, data: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const norm = (o: any) => {
  const v = JSON.parse(JSON.stringify(o).replace(/\?v=\d+/g, "?v=T"));
  if (v && typeof v === "object" && !Array.isArray(v)) { delete v.updated; delete v.seconds; }
  return v;
};

test("HTTP API: replay of the golden request script (static files, API, PIN, bots, traversal, jobs, photos)", async () => {
  const g = fixture("server-golden");
  const steps: any[] = fixture("server-steps");
  fixClock();
  const fakeNet = installFakeNet(fixture("net"));
  const root = tmpDir();
  copyDir(path.join(FX, "server-state"), root);
  const hh = config.load(root);
  // claude blocks until the script opens the gate, so "busy" is deterministic
  let gateOpen = false;
  const waiters: (() => void)[] = [];
  let claudeCalls = 0;
  const origExec = agent.runner.exec;
  agent.runner.exec = async () => {
    claudeCalls++;
    if (!gateOpen) await new Promise<void>((r) => waiters.push(r));
    return { stdout: JSON.stringify({ is_error: false, structured_output: { nachricht: "Job done", kandidaten: [] }, duration_ms: 4321, total_cost_usd: 0.0421 }), stderr: "" };
  };
  const port = await freePort();
  const { httpd } = await serve(hh, port);
  const status = () => { try { return JSON.parse(fs.readFileSync(path.join(hh.paths.jobs, "status.json"), "utf-8")); } catch { return {}; } };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    assert.equal((httpd.address() as net.AddressInfo).address, "127.0.0.1", "binds to [server] host");
    const results: any[] = [];
    for (const step of steps) {
      if (step.gate) {
        if (step.gate === "open") { gateOpen = true; waiters.splice(0).forEach((r) => r()); }
        else if (step.gate === "close") gateOpen = false;
        else if (step.gate === "wait_thinking") for (let i = 0; i < 200 && status().phase !== "thinking"; i++) await sleep(50);
        else if (step.gate === "wait_idle") { await sleep(200); for (let i = 0; i < 200 && status().running !== false; i++) await sleep(50); await sleep(200); }
        results.push({ gate: step.gate });
        continue;
      }
      const body = step.body === undefined ? undefined : typeof step.body === "string" ? step.body : JSON.stringify(step.body);
      const r = await request(port, step.method, step.path, step.headers, body);
      const ct = String(r.headers["content-type"] ?? "");
      const out: any = { name: step.name, status: r.status, headers: Object.fromEntries(KEEP.filter((k) => k in r.headers).map((k) => [k, String(r.headers[k])])) };
      if (ct.startsWith("text/html;charset")) { delete out.headers["content-length"]; out.body = null; }
      else if (step.ignore_body) { delete out.headers["content-length"]; out.body = null; }
      else if (ct.includes("application/json")) {
        if (step.name.startsWith("status")) delete out.headers["content-length"];
        out.body = norm(JSON.parse(r.data.toString("utf-8")));
        if (step.name === "status_error") {
          assert.match(out.body.summary, /not found/);
          out.body.summary = "<error text differs: Python TypeError vs. a clear message>";
        }
      }
      else out.body = { sha256: crypto.createHash("sha256").update(r.data).digest("hex"), size: r.data.length };
      results.push(out);
    }
    assert.equal(results.length, g.results.length);
    results.forEach((r, i) => sameJson(r, g.results[i], "step " + (r.name ?? r.gate)));
    const final = Object.fromEntries(Object.entries(snapshot(root)).filter(([k]) => !k.startsWith("jobs/") || k === "jobs/status.json").map(([k, v]) => [k, typeof v === "object" ? norm(v) : v]));
    assert.match(final["jobs/status.json"].summary, /not found/);
    final["jobs/status.json"].summary = "<error text differs>";
    sameJson(final, g.final, "household folder after the script");
    assertNet(fakeNet.take(), g.net, "network traffic");
    assert.equal(claudeCalls, g.claude_calls);
  } finally {
    agent.runner.exec = origExec;
    fakeNet.restore();
    httpd.close();
    httpd.closeAllConnections();
  }
});

test("server hardening beyond the golden script", async () => {
  const root = path.join(tmpDir(), "k");
  const log = console.log;
  console.log = () => {};
  cmd_init([root, "--lang", "en"]);
  console.log = log;
  const hh = config.load(root);
  hh.raw.server = { pin: "1234" };
  const port = await freePort();
  const { httpd } = await serve(hh, port);
  const browser = { "User-Agent": "Mozilla/5.0 Safari/604.1" };
  try {
    assert.ok(["0.0.0.0", "::"].includes((httpd.address() as net.AddressInfo).address), "default host is all interfaces");
    // crawlers: no content on any read method; robots.txt stays reachable and disallows everything
    for (const method of ["GET", "HEAD"]) assert.equal((await request(port, method, "/", { "User-Agent": "Googlebot/2.1" })).status, 403);
    const robots = await request(port, "GET", "/robots.txt", { "User-Agent": "Googlebot/2.1" });
    assert.equal(robots.status, 200);
    assert.equal(robots.data.toString(), "User-agent: *\nDisallow: /\n");
    // every response carries the privacy headers
    for (const p of ["/", "/api/config", "/nope", "/robots.txt"]) {
      const r = await request(port, "GET", p, browser);
      assert.equal(r.headers["x-robots-tag"], NOINDEX);
      assert.equal(r.headers["referrer-policy"], "no-referrer");
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.equal(r.headers["x-frame-options"], "DENY");
    }
    assert.equal(JSON.parse((await request(port, "GET", "/api/config", browser)).data.toString()).pin, true);
    assert.ok(!("server" in JSON.parse((await request(port, "GET", "/api/config", browser)).data.toString())), "no secrets in /api/config");
    // paths that must never be served
    for (const p of ["/img/%00", "/rounds/%00x", "/%00", "/img/..%5C..%5Chousehold.toml", "/rounds/%2e%2e%2fhousehold.toml", "/%2e%2e%2fhousehold.toml", "/img/%ZZ"]) {
      const r = await request(port, "GET", p, browser);
      assert.equal(r.status, 404, p);
      assert.ok(!r.data.toString().includes("[[persons]]"));
    }
    // the PIN is checked before anything is parsed or written
    const big = JSON.stringify({ pad: "x".repeat(210_000) });
    assert.equal((await request(port, "PUT", "/api/mailbox/x", { "X-Pin": "1234" }, big)).status, 400);
    assert.equal((await request(port, "PUT", "/api/mailbox/x", {}, "{}")).status, 401);
    assert.ok(!fs.existsSync(path.join(hh.paths.mailbox, "x.json")));
    assert.equal((await request(port, "PUT", "/api/mailbox/x", { "X-Pin": "1234" }, "[1]")).status, 400);
  } finally {
    httpd.close();
    httpd.closeAllConnections();
  }
});

test("PIN comparison is constant-time and length-independent", () => {
  assert.ok(pinMatches("1234", "1234"));
  for (const bad of ["", "123", "12345", "1235", "1234 ", "ä"]) assert.ok(!pinMatches(bad, "1234"), JSON.stringify(bad));
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf-8");
  assert.match(src, /timingSafeEqual/);
});

test("a server restart marks an interrupted job as failed", () => {
  const root = path.join(tmpDir(), "k");
  const log = console.log;
  console.log = () => {};
  cmd_init([root]);
  console.log = log;
  const hh = config.load(root);
  fs.writeFileSync(path.join(hh.paths.jobs, "status.json"), dumps({ running: true, phase: "thinking" }, 1));
  const s = new Jobs(hh).get();
  assert.deepStrictEqual([s.running, s.ok, s.phase, s.summary], [false, false, "error", "Interrupted: server restarted."]);
});
