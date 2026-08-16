import assert from "node:assert/strict";
import test from "node:test";

import { createAssetSourcePolicy, parseAllowedRemoteAssetUrl } from "./asset-source";

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
  "/repo/content/assets",
);

test("asset policy includes the configured bucket prefix for endpoint and public URLs", () => {
  assert.deepEqual(
    policy.remoteBases.map((url) => url.href),
    ["https://media.example.com/photos/cms/", "https://s3.cloud.ru/photos/cms/"],
  );
});

test("asset policy accepts an object inside the configured prefix", () => {
  assert.equal(
    parseAllowedRemoteAssetUrl("https://s3.cloud.ru/photos/cms/cover.jpg", policy).href,
    "https://s3.cloud.ru/photos/cms/cover.jpg",
  );
});

test("asset policy rejects sibling keys, buckets and normalized traversal", () => {
  for (const url of [
    "https://s3.cloud.ru/photos/private/cover.jpg",
    "https://s3.cloud.ru/other/cms/cover.jpg",
    "https://s3.cloud.ru/photos/cms/../private/cover.jpg",
  ]) {
    assert.throws(() => parseAllowedRemoteAssetUrl(url, policy), /outside the configured CMS media prefix/);
  }
});

test("asset policy rejects non-HTTPS and credential-bearing URLs", () => {
  assert.throws(() => parseAllowedRemoteAssetUrl("http://s3.cloud.ru/photos/cms/cover.jpg", policy), /plain HTTPS/);
  assert.throws(
    () => parseAllowedRemoteAssetUrl("https://user@s3.cloud.ru/photos/cms/cover.jpg", policy),
    /plain HTTPS/,
  );
});
