// Small helpers that reproduce Python semantics the original relied on (banker's rounding, float
// formatting, json.dumps spacing, truthiness, KeyError ...), so the output stays byte-identical.
import fs from "node:fs";
import path from "node:path";

export type Obj = Record<string, any>;

/** Test hook: tests pin the clock; production uses the real one. */
export const clock = { now: () => new Date() };

export class Fatal extends Error {} // like Python's SystemExit(message): printed, exit code 1
export class KeyError extends Error {
  key: unknown;
  constructor(key: unknown) {
    super(typeof key === "string" ? pyRepr(key) : String(key));
    this.key = key;
  }
}
export class ZeroDivisionError extends Error {}

export function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
}

/** dict[key] — throws KeyError like Python. */
export function need(o: any, key: string): any {
  if (!has(o, key)) throw new KeyError(key);
  return o[key];
}
export const has = (o: any, key: string): boolean => o != null && typeof o === "object" && Object.hasOwn(o, key);

/** Python truthiness (empty list/dict are falsy). */
export function truthy(v: any): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}

export function div(a: number, b: number): number {
  if (b === 0) throw new ZeroDivisionError("division by zero");
  return a / b;
}

// ---- rounding / number formatting -----------------------------------------------------------
/** Exact decimal rounding of the double's true value, ties to even — what Python's round()/format() do. */
function roundExact(x: number, nd: number): { neg: boolean; val: bigint } {
  if (!Number.isFinite(x)) throw new Error("cannot round " + x);
  const neg = x < 0 || Object.is(x, -0);
  const [ip, fp] = Math.abs(x).toFixed(100).split(".");
  const digits = ip + fp;
  const cut = ip.length + nd;
  if (cut < 0) return { neg, val: 0n };
  const kept = digits.slice(0, cut);
  const rest = digits.slice(cut);
  const lastOdd = kept.length > 0 && Number(kept[kept.length - 1]) % 2 === 1;
  const tie = rest[0] === "5" && /^0*$/.test(rest.slice(1));
  const up = rest[0] > "5" || (rest[0] === "5" && !tie) || (tie && lastOdd);
  return { neg, val: BigInt(kept || "0") + (up ? 1n : 0n) };
}

/** Python round(x, nd) for floats (nd may be negative); round(x) is pyRound(x, 0). */
export function pyRound(x: number, nd = 0): number {
  const { neg, val } = roundExact(x, nd);
  const s = val.toString().padStart(Math.max(nd, 0) + 1, "0");
  const n = nd > 0 ? Number(s.slice(0, -nd) + "." + s.slice(-nd)) : Number(s + "0".repeat(-nd));
  return n === 0 ? 0 : neg ? -n : n;
}

/** Python f"{x:.{nd}f}". */
export function fmtFixed(x: number, nd: number): string {
  const { neg, val } = roundExact(x, nd);
  const s = val.toString().padStart(nd + 1, "0");
  const body = nd ? s.slice(0, -nd) + "." + s.slice(-nd) : s;
  return (neg ? "-" : "") + body;
}

/** Python f"{x:,}" for a number that is an int (floats lose their ".0" — JSON.parse cannot tell). */
export function fmtThousands(x: number): string {
  const [i, f] = String(x).split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
}

/** str(float(x)) */
export function floatStr(x: number): string {
  return Number.isInteger(x) && Math.abs(x) < 1e16 ? x.toFixed(1) : String(x);
}

/** Python 3.12+ sum(): Neumaier-compensated for floats. */
export function pySum(xs: number[]): number {
  let s = 0, c = 0;
  for (const x of xs) {
    const t = s + x;
    if (!Number.isFinite(t)) { s = t; c = 0; continue; }
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return s + c;
}

/** str(x) of a JSON value as Python would print it in an f-string. */
export function pyStr(v: any): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** Python str slicing counts code points. */
export const cpSlice = (s: string, from: number, to?: number): string => [...s].slice(from, to).join("");
export const cpLen = (s: string): number => [...s].length;

// ---- JSON ---------------------------------------------------------------------------------------
/** json.dumps(obj[, indent]) with Python spacing; ensure_ascii=False unless `ascii`; undefined becomes null. */
export function dumps(v: any, indent?: number, ascii = false): string {
  const str = (s: string) => {
    const j = JSON.stringify(s);
    return ascii ? j.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : j;
  };
  const go = (v: any, level: number): string => {
    if (v === undefined || v === null) return "null";
    if (typeof v === "string") return str(v);
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
    if (typeof v === "boolean") return String(v);
    const nl = indent === undefined ? "" : "\n" + " ".repeat(indent * (level + 1));
    const end = indent === undefined ? "" : "\n" + " ".repeat(indent * level);
    const sep = indent === undefined ? ", " : "," + nl;
    if (Array.isArray(v)) return v.length ? "[" + nl + v.map((x) => go(x, level + 1)).join(sep) + end + "]" : "[]";
    const keys = Object.keys(v);
    return keys.length ? "{" + nl + keys.map((k) => str(k) + ": " + go(v[k], level + 1)).join(sep) + end + "}" : "{}";
  };
  return go(v, 0);
}

/** urllib.parse.quote(s, safe) */
export function pyQuote(s: string, safe = "/"): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, safe.includes("/") ? "/" : "%2F");
}

// ---- files ---------------------------------------------------------------------------------------
/** Path.read_text(): UTF-8 with universal newlines. */
export function readText(p: string): string {
  return fs.readFileSync(p, "utf-8").replace(/\r\n?/g, "\n");
}
export const exists = (p: string): boolean => fs.existsSync(p);
export const mkdirp = (p: string): void => void fs.mkdirSync(p, { recursive: true });

/** Path.resolve(): symlinks of the existing part are resolved, the rest is normalised. */
export function resolveLoose(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    tail.unshift(path.basename(cur));
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}

export const expandUser = (p: string): string =>
  p === "~" ? process.env.HOME ?? p : p.startsWith("~/") ? path.join(process.env.HOME ?? "~", p.slice(2)) : p;

// ---- dates (date-only values live in UTC so DST never shifts them) --------------------------------
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const today = (): Date => {
  const n = clock.now();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
};
export function fromIso(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid isoformat string: '${s}'`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86400000);
export const weekday = (d: Date): number => (d.getUTCDay() + 6) % 7; // Monday = 0
export const iso = (d: Date): string => d.toISOString().slice(0, 10);
export const ddmm = (d: Date): string => `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.`;
export const year = (d: Date): string => pad(d.getUTCFullYear(), 4);
export const dmy = (d: Date): string => ddmm(d) + year(d);
/** datetime.now().isoformat(timespec="seconds") */
export function nowIso(): string {
  const n = clock.now();
  return `${pad(n.getFullYear(), 4)}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
}
/** datetime.now():%Y%m%d-%H%M%S */
export function stamp(): string {
  return nowIso().replace(/[-:]/g, "").replace("T", "-");
}
