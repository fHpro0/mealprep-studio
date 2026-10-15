import assert from "node:assert/strict";
import test from "node:test";
import { fmtFixed, pyRound, pySum } from "../src/py.ts";
import { fixture } from "./helpers.ts";

const g = fixture("numfmt");
const eq = (a: unknown, b: unknown, msg: string) => assert.ok(a === b, `${msg}: ${a} !== ${b}`); // -0 === 0

test("round(x, n) and format(x, '.nf') match Python (banker's rounding on the exact binary value)", () => {
  for (const [x, nd, rounded, fixed] of g.grid) {
    eq(pyRound(x, nd), rounded, `round(${x}, ${nd})`);
    assert.equal(fmtFixed(x, nd), fixed, `format(${x}, .${nd}f)`);
  }
});

test("round(x, -2)", () => {
  for (const [x, nd, rounded, fixed] of g.neg) {
    eq(pyRound(x, nd), rounded, `round(${x}, ${nd})`);
    assert.equal(fmtFixed(pyRound(x, nd), 0), fixed);
  }
});

test("round(x) with ties to even", () => {
  for (const [x, r] of g.ints) eq(pyRound(x), r, `round(${x})`);
});

test("sum() uses Python 3.12+ compensated summation", () => {
  for (const [xs, s] of g.sums) assert.equal(pySum(xs), s, JSON.stringify(xs));
});
