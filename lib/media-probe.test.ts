import assert from "node:assert/strict";
import test from "node:test";

import { cacheStatus, evaluate, expectedMime, matrixMarkdown, maxAge, technicalResult, type ProbeRun } from "./media-probe";

const ORIGIN = "https://mikluha-maklai.s3.cloud.ru/cms/probe/v.webp";
const CDN = "https://media.example.test/cms/probe/v.webp";
const webp = { "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable" };

const passing = (): ProbeRun => ({
  originVariant: { url: ORIGIN, status: 200, headers: webp, sha256: "abc" },
  cdnVariant: { url: CDN, status: 200, headers: { ...webp, "access-control-allow-origin": "*" }, sha256: "abc" },
  cdnFirst: { url: `${CDN}?probe=1`, status: 200, headers: { ...webp, "x-cache": "MISS" } },
  cdnSecond: { url: `${CDN}?probe=1`, status: 200, headers: { ...webp, "x-cache": "HIT" } },
  cdnPlainHttp: { url: CDN.replace("https:", "http:"), status: 301, headers: { location: CDN } },
  originPrivate: { url: "https://mikluha-maklai.s3.cloud.ru/originals/p.jpg", status: 403, headers: {} },
  cdnPrivate: { url: "https://media.example.test/originals/p.jpg", status: 404, headers: {} },
  siteOrigin: "https://mikluha-maklai.ru",
  minTtlSeconds: 86_400,
});

test("cache status reads the common edge headers and falls back to Age", () => {
  assert.equal(cacheStatus({ "cf-cache-status": "HIT" }), "HIT");
  assert.equal(cacheStatus({ "x-cache": "Miss from edge" }), "MISS");
  assert.equal(cacheStatus({ "x-cache-status": "EXPIRED" }), "MISS");
  assert.equal(cacheStatus({ age: "12" }), "HIT");
  assert.equal(cacheStatus({}), "UNKNOWN");
});

test("TTL prefers s-maxage; the MIME type follows the variant's extension", () => {
  assert.equal(maxAge({ "cache-control": "public, max-age=60, s-maxage=86400" }), 86_400);
  assert.equal(maxAge({ "cache-control": "no-store" }), null);
  assert.equal(expectedMime(ORIGIN), "image/webp");
  assert.equal(expectedMime("https://x.test/a"), undefined);
});

test("a run that meets every rule is a technical pass", () => {
  const rows = evaluate(passing());
  assert.deepEqual(rows.filter((r) => r.verdict === "FAIL").map((r) => r.id), ["T12", "T13"]);
  assert.equal(technicalResult(rows), "TECHNICAL_PASS");
  assert.match(matrixMarkdown(rows), /^\| ID \| Check \|/);
});

test("any required failure fails the technical result", () => {
  const readablePrivate = { ...passing(), originPrivate: { ...passing().originPrivate, status: 200 } };
  assert.equal(technicalResult(evaluate(readablePrivate)), "TECHNICAL_FAIL");
  const neverHit = { ...passing(), cdnSecond: { ...passing().cdnSecond, headers: webp } };
  assert.equal(evaluate(neverHit).find((r) => r.id === "T5")!.verdict, "FAIL");
  const rewritten = { ...passing(), cdnVariant: { ...passing().cdnVariant, sha256: "other" } };
  assert.equal(technicalResult(evaluate(rewritten)), "TECHNICAL_FAIL");
  const tls = { ...passing(), cdnVariant: { url: CDN, status: null, error: "CERT_HAS_EXPIRED", headers: {} } };
  assert.match(evaluate(tls).find((r) => r.id === "T2")!.evidence, /CERT_HAS_EXPIRED/);
  const cookie = { ...passing(), cdnVariant: { ...passing().cdnVariant, headers: { ...webp, "set-cookie": "a=1" } } };
  assert.equal(evaluate(cookie).find((r) => r.id === "T7")!.verdict, "FAIL");
});
