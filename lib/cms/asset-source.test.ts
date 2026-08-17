import assert from "node:assert/strict";
import test from "node:test";

import {
  assertImageSource,
  assertVideoSource,
  createAssetSourcePolicy,
  parseAllowedRemoteAssetUrl,
} from "./asset-source";

const policy = createAssetSourcePolicy(
  {
    media_libraries: {
      aws_s3: {
        bucket: "photos",
        endpoint: "https://s3.cloud.ru",
        prefix: "cms/",
        public_url: "https://media.example.com/photos",
      },
    },
  },
);

test("asset policy includes the configured bucket prefix for endpoint and public URLs", () => {
  assert.deepEqual(
    policy.remoteBases.map((url) => url.href),
    ["https://media.example.com/photos/cms/", "https://s3.cloud.ru/photos/cms/"],
  );
});

test("asset policy accepts an object inside the configured prefix", () => {
  assert.equal(
    parseAllowedRemoteAssetUrl("https://s3.cloud.ru/photos/cms/cover.webp", policy).href,
    "https://s3.cloud.ru/photos/cms/cover.webp",
  );
});

test("asset policy rejects sibling keys, buckets and normalized traversal", () => {
  for (const url of [
    "https://s3.cloud.ru/photos/private/cover.webp",
    "https://s3.cloud.ru/other/cms/cover.webp",
    "https://s3.cloud.ru/photos/cms/../private/cover.webp",
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
  assert.doesNotThrow(() => assertImageSource("https://media.example.com/photos/cms/hero.webp", policy));
  assert.doesNotThrow(() => assertVideoSource("https://media.example.com/photos/cms/hero.webm", policy));
  assert.throws(() => assertImageSource("https://media.example.com/photos/cms/hero.jpg", policy), /must use \.webp/);
  assert.throws(() => assertVideoSource("https://media.example.com/photos/cms/hero.mp4", policy), /must use \.webm/);
  assert.throws(() => assertImageSource("/media/demo/../private.webp", policy), /tracked/);
});
