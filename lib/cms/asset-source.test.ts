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

// cloud.ru Evolution Object Storage only answers CORS preflight on the bucket's
// domain-style host, so `endpoint` there is a virtual-hosted-style bucket host,
// not the shared API host. See the pnpm patch note in RUNBOOK.md.
const domainStylePolicy = createAssetSourcePolicy(
  {
    media_libraries: {
      aws_s3: {
        bucket: "mikluha",
        endpoint: "https://mikluha-maklai.s3.cloud.ru",
        force_path_style: false,
        prefix: "cms/",
        public_url: "https://mikluha-maklai.s3.cloud.ru",
      },
    },
  },
);

test("force_path_style: false treats the endpoint as the bucket's own host, without the bucket segment", () => {
  assert.deepEqual(
    domainStylePolicy.remoteBases.map((url) => url.href),
    ["https://mikluha-maklai.s3.cloud.ru/cms/", "https://mikluha-maklai.s3.cloud.ru/cms/"],
  );
});

test("force_path_style: false accepts an object at the domain-style endpoint and rejects a path-style guess", () => {
  assert.equal(
    parseAllowedRemoteAssetUrl("https://mikluha-maklai.s3.cloud.ru/cms/cover.webp", domainStylePolicy).href,
    "https://mikluha-maklai.s3.cloud.ru/cms/cover.webp",
  );
  assert.throws(
    () => parseAllowedRemoteAssetUrl("https://mikluha-maklai.s3.cloud.ru/mikluha/cms/cover.webp", domainStylePolicy),
    /outside the configured CMS media prefix/,
  );
});

test("force_path_style unset (or true) keeps the bucket segment for a domain-style-looking endpoint", () => {
  const pathStylePolicy = createAssetSourcePolicy(
    {
      media_libraries: {
        aws_s3: {
          bucket: "mikluha",
          endpoint: "https://mikluha-maklai.s3.cloud.ru",
          prefix: "cms/",
        },
      },
    },
  );

  assert.deepEqual(pathStylePolicy.remoteBases.map((url) => url.href), [
    "https://mikluha-maklai.s3.cloud.ru/mikluha/cms/",
  ]);
});
