import assert from "node:assert/strict";
import test from "node:test";

import { formatRub } from "./format";

// Intl separates groups and the currency sign with non-breaking spaces.
const plain = (s: string) => s.replace(/\s/g, " ");

test("whole rubles keep their form; kopecks from Commerce are shown, not rounded", () => {
  assert.equal(plain(formatRub(34_500)), "34 500 ₽");
  assert.equal(plain(formatRub(34_500.5)), "34 500,50 ₽");
  assert.equal(plain(formatRub(34_500.05)), "34 500,05 ₽");
});
