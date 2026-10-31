import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parsePublicLegalPages } from "./legal-projection";

const row = (body = "Точная редакция\nс пробелами  \n") => ({
  slug: "privacy-policy", title: "Политика", body, publishedVersion: 2, effectiveOn: "2026-01-01",
  documentSha256: `sha256:${"a".repeat(64)}`,
  textSha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
});

test("active legal bytes and publication identity reach the view unchanged", () => {
  const source = row();
  const page = parsePublicLegalPages([source])[0]!;
  assert.equal(page.content, source.body);
  assert.deepEqual(page.publication, { version: 2, documentSha256: source.documentSha256, textSha256: source.textSha256 });
  assert.equal(parsePublicLegalPages([row("Новая редакция")])[0]!.content, "Новая редакция");
  assert.deepEqual(parsePublicLegalPages([]), [], "no active publication never resurrects baked text");
});

test("missing, duplicate, tampered, future or invalid legal rows fail closed", () => {
  for (const value of [null, undefined, {}, [null], [row(), row()],
    [{ ...row(), body: "Подменённый текст" }], [{ ...row(), textSha256: null }],
    [{ ...row(), publishedVersion: 0 }], [{ ...row(), effectiveOn: "2099-01-01" }],
    [{ ...row(), effectiveOn: "2026-02-30" }], [{ ...row(), documentSha256: "bad" }],
    [{ ...row(), slug: "tours" }], [{ ...row(), slug: "admin" }], [{ ...row(), slug: "../oferta" }]]) {
    assert.throws(() => parsePublicLegalPages(value));
  }
});
