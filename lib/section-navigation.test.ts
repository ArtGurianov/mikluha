import assert from "node:assert/strict";
import { test } from "node:test";

import { getRepeatedSectionId, scrollToRepeatedSection } from "./section-navigation";

test("repeated section navigation resolves both root and hash-only links", () => {
  const current = "https://example.com/#contacts";

  assert.equal(getRepeatedSectionId(current, "/#contacts"), "contacts");
  assert.equal(getRepeatedSectionId(current, "#contacts"), "contacts");
});

test("different routes, queries, or hashes remain normal navigation", () => {
  assert.equal(getRepeatedSectionId("https://example.com/#contacts", "/#tours"), undefined);
  assert.equal(getRepeatedSectionId("https://example.com/tours/altai/#contacts", "/#contacts"), undefined);
  assert.equal(getRepeatedSectionId("https://example.com/?view=all#contacts", "/#contacts"), undefined);
});

test("repeated navigation scrolls the matching section and reports that it handled the click", () => {
  let requestedId = "";
  let scrollCount = 0;

  const handled = scrollToRepeatedSection(
    "https://example.com/#contacts",
    "/#contacts",
    (id) => {
      requestedId = id;
      return { scrollIntoView: () => scrollCount++ };
    },
  );

  assert.equal(handled, true);
  assert.equal(requestedId, "contacts");
  assert.equal(scrollCount, 1);
});

test("missing sections fall back to the link's normal behavior", () => {
  const handled = scrollToRepeatedSection("https://example.com/#contacts", "/#contacts", () => null);
  assert.equal(handled, false);
});
