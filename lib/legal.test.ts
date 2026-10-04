import assert from "node:assert/strict";
import test from "node:test";

import { REQUIRED_LEGAL_SLUGS } from "./legal";

test("the launch legal set is explicit and excludes the retired booking terms page", () => {
  assert.deepEqual([...REQUIRED_LEGAL_SLUGS].sort(), [
    "cookies",
    "oferta",
    "otkaz-i-vozvrat",
    "pravila-oplaty",
    "privacy-policy",
    "soglasie-pd",
    "turoperator",
  ]);
  assert.equal((REQUIRED_LEGAL_SLUGS as readonly string[]).includes("booking-terms"), false);
});
