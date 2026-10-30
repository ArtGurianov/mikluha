import assert from "node:assert/strict";
import test from "node:test";
import { assertImageSource, assertVideoSource, parseAllowedRemoteAssetUrl, SITE_MEDIA_POLICY as policy } from "./asset-source";

test("asset policy accepts an object inside the configured prefix", () => {
  assert.equal(
    parseAllowedRemoteAssetUrl("https://mikluha-maklai.s3.cloud.ru/cms/cover.webp", policy).href,
    "https://mikluha-maklai.s3.cloud.ru/cms/cover.webp",
  );
});

test("asset policy rejects sibling keys, buckets and normalized traversal", () => {
  for (const url of [
    "https://s3.cloud.ru/photos/private/cover.webp",
    "https://s3.cloud.ru/other/cms/cover.webp",
    "https://mikluha-maklai.s3.cloud.ru/cms/../private/cover.webp",
  ]) {
    assert.throws(() => parseAllowedRemoteAssetUrl(url, policy), /outside the configured CMS media prefix/);
  }
});

test("asset policy rejects non-HTTPS and credential-bearing URLs", () => {
  assert.throws(() => parseAllowedRemoteAssetUrl("http://s3.cloud.ru/photos/cms/cover.webp", policy), /plain HTTPS/);
  assert.throws(
    () => parseAllowedRemoteAssetUrl("https://user@s3.cloud.ru/photos/cms/cover.webp", policy),
    /plain HTTPS/,
  );
});

test("media policy accepts only direct WebP images and WebM videos", () => {
  assert.doesNotThrow(() => assertImageSource("/media/demo/hero.webp", policy));
  assert.doesNotThrow(() => assertImageSource("https://mikluha-maklai.s3.cloud.ru/cms/hero.webp", policy));
  assert.doesNotThrow(() => assertVideoSource("https://mikluha-maklai.s3.cloud.ru/cms/hero.webm", policy));
  assert.throws(() => assertImageSource("https://mikluha-maklai.s3.cloud.ru/cms/hero.jpg", policy), /must use \.webp/);
  assert.throws(() => assertVideoSource("https://mikluha-maklai.s3.cloud.ru/cms/hero.mp4", policy), /must use \.webm/);
  assert.throws(() => assertImageSource("/media/demo/../private.webp", policy), /tracked/);
});
