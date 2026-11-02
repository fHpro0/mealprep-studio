// Isometric plate illustration of a dish, drawn from the `teller` components Claude describes.
// Deterministic (seeded by the dish id), so the same dish always looks the same.
import type { Obj } from "./py.ts";

const W = 800, H = 560, CX = 400, CY = 300;
const RX = 290, RY = 145;          // plate, 2:1 isometric ellipse
const FX = 215, FY = 107;          // food area inside the rim
const FORMS = new Set(["sauce", "kruste", "haufen", "stuecke", "streifen", "kugeln", "scheiben", "klecks", "streusel"]);

type Pt = [number, number];

/** Lit noise texture tinted by the shape's own colour; `spec` adds wet/fatty highlights. */
const tex = (id: string, freq: number, depth: number, spec: number, seed: number) =>
  `<filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">`
  + `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="3" seed="${seed}" result="n"/>`
  + `<feDiffuseLighting in="n" surfaceScale="${depth}" diffuseConstant="1.2" lighting-color="#fff" result="d"><feDistantLight azimuth="235" elevation="52"/></feDiffuseLighting>`
  + `<feComposite in="d" in2="SourceGraphic" operator="arithmetic" k1="1.08" result="c"/>`
  + `<feSpecularLighting in="n" surfaceScale="${depth}" specularConstant="${spec}" specularExponent="22" lighting-color="#fff8e6" result="s"><feDistantLight azimuth="235" elevation="52"/></feSpecularLighting>`
  + `<feComposite in="c" in2="s" operator="arithmetic" k2="1" k3="1" result="cs"/>`
  + `<feComposite in="cs" in2="SourceAlpha" operator="in"/></filter>`;
const DEFS = tex("crumb", 0.13, 4, 0.35, 7) + tex("crust", 0.05, 2.6, 0.3, 2) + tex("gloss", 0.012, 1.2, 0.3, 5)
  + tex("sear", 0.18, 0.8, 0.12, 9) + tex("grain", 0.32, 2.2, 0.2, 4) + `<filter id="soft"><feGaussianBlur stdDeviation="5"/></filter>`;
type Part = { name: string; farbe: string; form: string; anteil: number };

function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lighten (f > 0) or darken (f < 0) a #rrggbb colour. */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (c: number) => Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f);
  return "#" + [n >> 16, (n >> 8) & 255, n & 255].map((c) => ch(c).toString(16).padStart(2, "0")).join("");
}

/** Blend two #rrggbb colours, t = share of b. */
function mix(a: string, b: string, t: number): string {
  const [x, y] = [a, b].map((h) => parseInt(h.slice(1), 16));
  return "#" + [16, 8, 0].map((k) => Math.round(((x >> k) & 255) * (1 - t) + ((y >> k) & 255) * t).toString(16).padStart(2, "0")).join("");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
const pts = (p: Pt[]) => p.map(([x, y]) => `${f1(x)},${f1(y)}`).join(" ");
/** plate plane (unit disk) → screen */
const proj = (u: number, v: number, h = 0): Pt => [CX + u * FX, CY + v * FY - h];

/** Untrusted model output → safe, bounded parts. */
export function clean(teller: unknown): Part[] {
  if (!Array.isArray(teller)) return [];
  return teller.slice(0, 8).filter((t) => t && typeof t === "object").map((t: Obj) => ({
    name: String(t.name ?? "").slice(0, 60),
    farbe: /^#[0-9a-f]{6}$/i.test(String(t.farbe)) ? String(t.farbe).toLowerCase() : "#b8a58a",
    form: FORMS.has(t.form) ? t.form : "stuecke",
    anteil: Math.min(100, Math.max(1, Number(t.anteil) || 10)),
  }));
}

function hull(p: Pt[]): Pt[] {
  const s = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Pt[]) => {
    const out: Pt[] = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    return out.slice(0, -1);
  };
  return [...half(s), ...half([...s].reverse())];
}

/** A flat convex piece lifted by h: dark sides (hull of top and bottom), light top. */
function prism(top: Pt[], h: number, color: string): string {
  const bottom = top.map(([x, y]): Pt => [x, y + h]);
  return `<polygon points="${pts(hull([...top, ...bottom]))}" fill="${shade(color, -0.32)}"/>`
    + `<polygon points="${pts(top)}" fill="${shade(color, 0.12)}"/>`;
}

/** Smooth closed wobbly blob around (u, v) with plane radius r. */
function blob(rand: () => number, u: number, v: number, r: number, h: number, wobble = 0.12): string {
  const n = 14, p: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, k = r * (1 - wobble + rand() * wobble * 2);
    p.push(proj(u + Math.cos(a) * k, v + Math.sin(a) * k, h));
  }
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let d = `M${pts([mid(p[n - 1], p[0])])}`;
  for (let i = 0; i < n; i++) d += ` Q${pts([p[i]])} ${pts([mid(p[i], p[(i + 1) % n])])}`;
  return d + "Z";
}

/** Random point in a disk of radius r around (u, v), kept on the plate. */
function inDisk(rand: () => number, u: number, v: number, r: number): [number, number] {
  for (;;) {
    const a = rand() * Math.PI * 2, k = Math.sqrt(rand()) * r, x = u + Math.cos(a) * k, y = v + Math.sin(a) * k;
    if (x * x + y * y < 0.85) return [x, y];
  }
}

function piece(rand: () => number, form: string, color: string, u: number, v: number, lift: number): string {
  const [x, y] = proj(u, v, lift);
  const turn = rand() * Math.PI;
  const rect = (len: number, wid: number): Pt[] => [[-len, -wid], [len, -wid], [len, wid], [-len, wid]]
    .map(([a, b]): Pt => [x + (a * Math.cos(turn) - b * Math.sin(turn)), y + (a * Math.sin(turn) + b * Math.cos(turn)) * 0.5]);
  const shadow = `<ellipse cx="${f1(x + 3)}" cy="${f1(y + 4)}" rx="${f1(16)}" ry="${f1(6)}" fill="#000" opacity=".12"/>`;
  switch (form) {
    case "stuecke": { const s = 10 + rand() * 6; return shadow + `<g filter="url(#sear)">${prism(rect(s, s), s * 0.9, color)}</g>` }
    case "streifen": return shadow + `<g filter="url(#sear)">${prism(rect(24 + rand() * 10, 6 + rand() * 2), 7, color)}</g>`;
    case "kugeln": {
      const r = 13 + rand() * 6;
      return shadow + `<circle cx="${f1(x)}" cy="${f1(y - r * 0.8)}" r="${f1(r)}" fill="${shade(color, -0.12)}" filter="url(#gloss)"/>`
        + `<circle cx="${f1(x - r * 0.3)}" cy="${f1(y - r * 1.1)}" r="${f1(r * 0.45)}" fill="${shade(color, 0.35)}" opacity=".7"/>`;
    }
    case "scheiben": {
      const r = 15 + rand() * 4;
      return `<ellipse cx="${f1(x)}" cy="${f1(y + 3)}" rx="${f1(r)}" ry="${f1(r / 2)}" fill="${shade(color, -0.3)}"/>`
        + `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(r)}" ry="${f1(r / 2)}" fill="${shade(color, 0.1)}"/>`
        + `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(r * 0.65)}" ry="${f1(r * 0.32)}" fill="${shade(color, 0.4)}"/>`;
    }
    default: return "";
  }
}

/** A dome (rice, mince, mash, dollop) with base radius r on the plane. */
function dome(rand: () => number, color: string, u: number, v: number, r: number, lift: number, grains: boolean): string {
  const [x, y] = proj(u, v, lift), w = r * FX, d = r * FY, h = Math.max(22, w * 0.85);
  const shape = (k: number, dx: number) => `M${f1(x - w * k + dx)},${f1(y)} C${f1(x - w * k + dx)},${f1(y - h * 1.25 * k)} ${f1(x + w * k + dx)},${f1(y - h * 1.25 * k)} ${f1(x + w * k + dx)},${f1(y)} `
    + `A${f1(w * k)},${f1(d * k)} 0 0 1 ${f1(x - w * k + dx)},${f1(y)}Z`;
  // dark body, lit top-left body on it, then a soft highlight: reads as a 3D mound
  let s = `<ellipse cx="${f1(x + 8)}" cy="${f1(y + 6)}" rx="${f1(w)}" ry="${f1(d)}" fill="#000" opacity=".14"/>`
    + `<g filter="url(#${grains ? (parseInt(color.slice(1, 3), 16) > 170 ? "grain" : "crumb") : "gloss"})">`
    + `<path d="${shape(1, 0)}" fill="${shade(color, -0.22)}"/>`
    + `<path d="${shape(0.9, -w * 0.08)}" fill="${color}"/></g>`
    + `<ellipse cx="${f1(x - w * 0.3)}" cy="${f1(y - h * 0.62)}" rx="${f1(w * 0.32)}" ry="${f1(h * 0.2)}" fill="${shade(color, 0.35)}" opacity=".5"/>`;
  if (grains) for (let i = 0; i < Math.round(w / 2.5); i++) {
    const gx = x + (rand() * 2 - 1) * w * 0.85, top = y - h * 0.9 * (1 - ((gx - x) / w) ** 2);
    const gy = top + rand() * (y + d * 0.6 - top);
    s += `<ellipse cx="${f1(gx)}" cy="${f1(gy)}" rx="2.6" ry="1.4" fill="${shade(color, rand() < 0.5 ? 0.35 : -0.18)}" transform="rotate(${Math.round(rand() * 180)} ${f1(gx)} ${f1(gy)})"/>`;
  }
  return s;
}

export function render(id: string, title: string, teller: unknown, warm = false): string {
  const parts = clean(teller), rand = rng(id);
  const base = parts.filter((p) => p.form === "sauce" || p.form === "kruste");
  const loose = parts.filter((p) => !["sauce", "kruste", "streusel"].includes(p.form));
  const lift = base.some((p) => p.form === "kruste") ? 20 : base.length ? 3 : 0;
  let back = "", sorted: [number, string][] = [], front = "";

  for (const p of base) {
    const r = Math.min(0.95, Math.max(0.6, Math.sqrt(p.anteil / 100) * 1.25));
    if (p.form === "sauce") {
      back += `<path d="${blob(rand, 0, 0.04, r, -3)}" fill="${shade(p.farbe, -0.25)}"/>`
        + `<path d="${blob(rand, 0, 0, r, 0)}" fill="${p.farbe}" filter="url(#gloss)"/>`
        + `<path d="${blob(rand, -0.2, -0.15, r * 0.35, 0, 0.3)}" fill="${shade(p.farbe, 0.25)}" opacity=".5"/>`;
    } else {
      const top = blob(rand, 0, 0, r * 0.92, 20, 0.06);
      back += `<path d="${blob(rand, 0, 0, r * 0.92, 0, 0.06)}" fill="${mix(p.farbe, "#5a3416", 0.6)}"/>`
        + `<path d="${top}" fill="${p.farbe}" filter="url(#crust)"/>`;
      // gratin browning: soft dark-golden patches
      back += `<g filter="url(#soft)" opacity=".6">`;
      for (let i = 0; i < 14; i++) {
        const [u, v] = inDisk(rand, 0, 0, r * 0.75), [x, y] = proj(u, v, 20);
        back += `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(10 + rand() * 18)}" ry="${f1(5 + rand() * 8)}" fill="${shade(p.farbe, -0.42)}"/>`;
      }
      back += `</g>`;
    }
  }

  // each loose component gets its own spot on the plate, sized by its share
  const total = loose.reduce((s, p) => s + p.anteil, 0);
  let angle = -Math.PI * 0.75;
  for (const p of loose) {
    const sweep = (p.anteil / total) * Math.PI * 2, mid = angle + sweep / 2;
    angle += sweep;
    const dist = loose.length > 1 ? 0.42 : 0, u = Math.cos(mid) * dist, v = Math.sin(mid) * dist;
    const r = Math.min(0.6, Math.max(0.22, Math.sqrt(p.anteil / 100) * 0.75));
    if (p.form === "haufen" || p.form === "klecks") {
      const small = p.form === "klecks";
      const rr = small ? Math.min(r, 0.2) : r;
      sorted.push([proj(u, v)[1], dome(rand, small ? shade(p.farbe, 0.05) : p.farbe, u, v, rr, lift, !small)]);
      continue;
    }
    const n = Math.min(14, Math.max(3, Math.round(p.anteil / (p.form === "streifen" ? 3.5 : 4.5))));
    for (let i = 0; i < n; i++) {
      const [a, b] = inDisk(rand, u, v, r);
      sorted.push([proj(a, b)[1], piece(rand, p.form, p.farbe, a, b, lift)]);
    }
  }
  sorted = sorted.sort((a, b) => a[0] - b[0]);

  for (const p of parts.filter((q) => q.form === "streusel")) {
    for (let i = 0; i < Math.min(90, Math.max(20, p.anteil * 6)); i++) {
      const [u, v] = inDisk(rand, 0, 0, 0.8), [x, y] = proj(u, v, lift + 14 + rand() * 10);
      front += `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(2 + rand() * 3)}" ry="${f1(1.2 + rand() * 1.5)}" fill="${shade(p.farbe, rand() * 0.3 - 0.15)}" transform="rotate(${Math.round(rand() * 180)} ${f1(x)} ${f1(y)})"/>`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="70 118 660 412" width="660" height="412" role="img"><title>${esc(title)}</title>`
    + `<defs><radialGradient id="light" cx="45%" cy="45%" r="70%"><stop offset="0" stop-color="#ffd9a0" stop-opacity=".25"/><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>`
    + `<filter id="wood" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.11" numOctaves="3" seed="11"/>`
    + `<feColorMatrix values="0 0 0 0 .22  0 0 0 0 .12  0 0 0 0 .05  1.3 0 0 0 -.4"/></filter>${DEFS}</defs>`
    // warm wooden table, planks along the isometric diagonal
    + `<rect width="${W}" height="${H}" fill="#9c6b3e"/>`
    + `<g transform="rotate(-27 ${CX} ${CY})"><rect x="-300" y="-400" width="1400" height="1400" filter="url(#wood)"/>`
    + Array.from({ length: 16 }, (_, i) => `<rect x="-300" y="${-400 + i * 95}" width="1400" height="2" fill="#5b3a1e" opacity=".55"/>`).join("") + `</g>`
    + `<rect width="${W}" height="${H}" fill="url(#light)"/>`
    + `<ellipse cx="${CX + 14}" cy="${CY + 34}" rx="${RX}" ry="${RY}" fill="#7a6248" opacity=".22"/>`
    + `<ellipse cx="${CX}" cy="${CY + 14}" rx="${RX}" ry="${RY}" fill="#cfc8bc"/>`
    + `<ellipse cx="${CX}" cy="${CY}" rx="${RX}" ry="${RY}" fill="#fbfaf6"/>`
    + `<ellipse cx="${CX}" cy="${CY + 6}" rx="${RX * 0.8}" ry="${RY * 0.8}" fill="#efebe3"/>`
    + `<ellipse cx="${CX}" cy="${CY + 3}" rx="${RX * 0.78}" ry="${RY * 0.78}" fill="#f7f4ee"/>`
    + `<path d="M${CX - RX * 0.93},${CY - RY * 0.2} A${RX * 0.97},${RY * 0.97} 0 0 1 ${CX + RX * 0.35},${CY - RY * 0.93}" stroke="#fff" stroke-width="3" fill="none" opacity=".9"/>`
    + back + sorted.map(([, s]) => s).join("") + front
    + (warm ? `<g filter="url(#soft)" opacity=".38" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round">`
      + [-60, 0, 60].map((dx, i) => `<path d="M${CX + dx},${CY - 75} c-22,-30 22,-50 0,-80 c-22,-30 22,-50 0,-${70 + i * 15}"/>`).join("") + `</g>` : "")
    + `</svg>`;
}
