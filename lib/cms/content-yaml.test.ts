import assert from "node:assert/strict";
import { test } from "node:test";

import { loadContentYaml } from "./content-yaml";

test("a Sveltia date-only value remains a calendar-date string", () => {
  const content = loadContentYaml("startDate: 2026-06-15\nendDate: 2026-06-19\n") as Record<string, unknown>;

  assert.equal(content.startDate, "2026-06-15");
  assert.equal(content.endDate, "2026-06-19");
});

test("content's JSON scalar types stay intact", () => {
  const content = loadContentYaml("price: 28500\nisListed: true\npaymentQr: null\n") as Record<string, unknown>;

  assert.equal(content.price, 28500);
  assert.equal(content.isListed, true);
  assert.equal(content.paymentQr, null);
});
