import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import yaml from "js-yaml";

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

test("the generic legal pack selects actual-expense refunds without fixed penalties, live facts or a fictitious closing-receipt grace", () => {
  const page = (slug: string) => yaml.load(readFileSync(join(process.cwd(), `content/legal/${slug}.yml`), "utf8"),
    { schema: yaml.JSON_SCHEMA }) as { content: string; refundPolicy?: string };
  const offer = page("oferta");
  assert.equal(offer.refundPolicy, "DOCUMENTED_EXPENSES");
  for (const text of [offer.content, page("otkaz-i-vozvrat").content]) {
    assert.match(text, /пять календарных дней/);
    assert.match(text, /подтвержд[ёе]нн/);
    assert.match(text, /refunds@mikluha-maklai\.ru/);
    assert.match(text, /неявк/i);
    assert.doesNotMatch(text, /50%|0% возврат|только полный возврат|вычитаются? не/);
  }
  assert.doesNotMatch(offer.content, /altai-1|26\s?500|29\.10\.2026|01\.11\.2026/);
  assert.match(offer.content, /Изменение существенных условий Заявки требует соглашения сторон/);
  assert.match(page("pravila-oplaty").content, /фактического оказания/);
  assert.match(page("privacy-policy").content, /Telegram, WhatsApp или Google Sheets/);
});

test("the frozen launch privacy artifacts disclose the transactional email processor and its narrow data set", () => {
  const privacy = readFileSync(join(process.cwd(), "content/legal/privacy-policy.yml"), "utf8");
  const consent = readFileSync(join(process.cwd(), "content/legal/soglasie-pd.yml"), "utf8");

  for (const artifact of [privacy, consent]) {
    assert.match(artifact, /Notisend/);
    assert.doesNotMatch(artifact, /unisender/i);
    assert.match(artifact, /email/);
    assert.match(artifact, /номер заказа/);
    assert.match(artifact, /защищенн(?:ая|ой) ссылк/);
    assert.match(artifact, /ФИО(?: туристов)?, даты рождения, гражданство и (?:реквизиты )?документ/);
  }
  assert.match(privacy, /Российской Федерации/);
  assert.match(privacy, /договорным, а не рекламным/);
});
