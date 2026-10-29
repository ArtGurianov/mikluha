import assert from "node:assert/strict";
import test from "node:test";

import { cacheStatus, evaluate, expectedMime, matrixMarkdown, maxAge, technicalResult, type ProbeRun } from "./media-probe";

const ORIGIN = "https://mikluha-maklai.s3.cloud.ru/cms/probe/v.webp";
const CDN = "https://media.example.test/cms/probe/v.webp";
const PRIVATE = "https://mikluha-maklai.s3.cloud.ru/originals/p.jpg";
const CDN_PRIVATE = "https://media.example.test/originals/p.jpg";
const webp = { "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable" };

const passing = (): ProbeRun => ({
  originVariant: { url: ORIGIN, status: 200, headers: webp, sha256: "abc" },
  cdnVariant: { url: CDN, status: 200, headers: { ...webp, "access-control-allow-origin": "*" }, sha256: "abc" },
  cdnFirst: { url: `${CDN}?probe=1`, status: 200, headers: { ...webp, "x-cache": "MISS" } },
  cdnSecond: { url: `${CDN}?probe=1`, status: 200, headers: { ...webp, "x-cache": "HIT" } },
  cdnPlainHttp: { url: CDN.replace("https:", "http:"), status: 301, headers: { location: CDN } },
  privateExists: { url: "https://s3.cloud.ru/mikluha-maklai/originals/p.jpg", status: 200, headers: {} },
  originPrivate: { url: PRIVATE, status: 403, headers: {} },
  cdnPrivate: { url: CDN_PRIVATE, status: 404, headers: {} },
  siteOrigin: "https://mikluha-maklai.ru",
  minTtlSeconds: 86_400,
});

const verdict = (run: ProbeRun, id: string) => evaluate(run).find((r) => r.id === id)!;

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
  assert.deepEqual(rows.map((r) => r.id), ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13", "T14"]);
  assert.deepEqual(rows.filter((r) => r.verdict === "FAIL").map((r) => r.id), ["T13", "T14"]);
  assert.equal(technicalResult(rows), "TECHNICAL_PASS");
  assert.match(matrixMarkdown(rows), /^\| ID \| Check \|/);
});

test("a network failure is never a refusal of access", () => {
  const dns = { ...passing(), originPrivate: { url: PRIVATE, status: null, error: "ENOTFOUND", headers: {} } };
  assert.equal(verdict(dns, "T9").verdict, "FAIL");
  assert.equal(technicalResult(evaluate(dns)), "TECHNICAL_FAIL");
  const timeout = { ...passing(), cdnPrivate: { url: CDN_PRIVATE, status: null, error: "TimeoutError", headers: {} } };
  assert.equal(verdict(timeout, "T10").verdict, "FAIL");
  assert.match(verdict(timeout, "T10").evidence, /TimeoutError/);
});

test("a 403/404 proves nothing unless the original is known to exist", () => {
  const missing = { ...passing(), privateExists: { ...passing().privateExists, status: 404 } };
  assert.deepEqual(["T8", "T9", "T10"].map((id) => verdict(missing, id).verdict), ["FAIL", "FAIL", "FAIL"]);
  assert.match(verdict(missing, "T9").evidence, /existence not confirmed/);
  const unauthorized = { ...passing(), privateExists: { ...passing().privateExists, status: 403 } };
  assert.equal(technicalResult(evaluate(unauthorized)), "TECHNICAL_FAIL");
  const unreachable = { ...passing(), privateExists: { url: PRIVATE, status: null, error: "ECONNREFUSED", headers: {} } };
  assert.equal(technicalResult(evaluate(unreachable)), "TECHNICAL_FAIL");
});

test("any other required failure fails the technical result", () => {
  const readable = { ...passing(), cdnPrivate: { ...passing().cdnPrivate, status: 200 } };
  assert.equal(technicalResult(evaluate(readable)), "TECHNICAL_FAIL");
  const neverHit = { ...passing(), cdnSecond: { ...passing().cdnSecond, headers: webp } };
  assert.equal(verdict(neverHit, "T5").verdict, "FAIL");
  const rewritten = { ...passing(), cdnVariant: { ...passing().cdnVariant, sha256: "other" } };
  assert.equal(technicalResult(evaluate(rewritten)), "TECHNICAL_FAIL");
  const tls = { ...passing(), cdnVariant: { url: CDN, status: null, error: "CERT_HAS_EXPIRED", headers: {} } };
  assert.match(verdict(tls, "T2").evidence, /CERT_HAS_EXPIRED/);
  const cookie = { ...passing(), cdnVariant: { ...passing().cdnVariant, headers: { ...webp, "set-cookie": "a=1" } } };
  assert.equal(verdict(cookie, "T7").verdict, "FAIL");
  const noCors = { ...passing(), cdnVariant: { ...passing().cdnVariant, headers: webp } };
  assert.equal(verdict(noCors, "T12").verdict, "FAIL");
  assert.equal(technicalResult(evaluate(noCors)), "TECHNICAL_FAIL");
});
