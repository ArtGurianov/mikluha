import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

test("the frozen launch privacy artifacts disclose the transactional email processor and its narrow data set", () => {
  const privacy = readFileSync(join(process.cwd(), "content/legal/privacy-policy.yml"), "utf8");
  const consent = readFileSync(join(process.cwd(), "content/legal/soglasie-pd.yml"), "utf8");

  for (const artifact of [privacy, consent]) {
    assert.match(artifact, /UniSender Go/);
    assert.match(artifact, /email/);
    assert.match(artifact, /номер заказа/);
    assert.match(artifact, /защищенн(?:ая|ой) ссылк/);
    assert.match(artifact, /ФИО(?: туристов)?, даты рождения, гражданство и (?:реквизиты )?документ/);
  }
  assert.match(privacy, /Российской Федерации/);
  assert.match(privacy, /договорным, а не рекламным/);
});
