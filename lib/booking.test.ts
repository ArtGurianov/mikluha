import assert from "node:assert/strict";
import test from "node:test";

import { commerceBookingUrl } from "./booking";

test("booking links the exact departure to the configured commerce origin", () => {
  assert.equal(
    commerceBookingUrl("https://book.mikluha-maklai.ru", "altai-2026-10-10"),
    "https://book.mikluha-maklai.ru/book?departure=altai-2026-10-10",
  );
});
