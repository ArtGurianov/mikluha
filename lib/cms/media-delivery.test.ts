import assert from "node:assert/strict";
import test from "node:test";

import { mediaDeliveryFromEnv, resolveMediaUrl, withMediaDelivery } from "./media-delivery";

const ORIGIN = "https://mikluha-maklai.s3.cloud.ru/cms/";
const CDN = "https://media.example.com/cms/";
const cdn = mediaDeliveryFromEnv({ MEDIA_DELIVERY: "cdn", MEDIA_ORIGIN_BASE: ORIGIN, MEDIA_CDN_BASE: CDN });

test("direct is the default and leaves every URL as stored", () => {
  const direct = mediaDeliveryFromEnv({});
  assert.equal(direct.mode, "direct");
  assert.equal(resolveMediaUrl(`${ORIGIN}a.webp`, direct), `${ORIGIN}a.webp`);
});

test("cdn rewrites only URLs under the origin base, keeping the rest of the path", () => {
  assert.equal(resolveMediaUrl(`${ORIGIN}tours/a b.webp`, cdn), "https://media.example.com/cms/tours/a%20b.webp");
  // Outside the public prefix (a private original, another bucket, a same-origin demo file): untouched.
  assert.equal(resolveMediaUrl("https://mikluha-maklai.s3.cloud.ru/originals/a.jpg", cdn),
    "https://mikluha-maklai.s3.cloud.ru/originals/a.jpg");
  assert.equal(resolveMediaUrl("https://mikluha-maklai.s3.cloud.ru/cms/../originals/a.jpg", cdn),
    "https://mikluha-maklai.s3.cloud.ru/cms/../originals/a.jpg");
  assert.equal(resolveMediaUrl("https://other.s3.cloud.ru/cms/a.webp", cdn), "https://other.s3.cloud.ru/cms/a.webp");
  assert.equal(resolveMediaUrl("/media/demo/a.webp", cdn), "/media/demo/a.webp");
});

test("a misconfigured switch fails instead of guessing", () => {
  assert.throws(() => mediaDeliveryFromEnv({ MEDIA_DELIVERY: "turboflare" }), /must be "direct" or "cdn"/);
  assert.throws(() => mediaDeliveryFromEnv({ MEDIA_DELIVERY: "cdn", MEDIA_ORIGIN_BASE: ORIGIN }), /MEDIA_CDN_BASE/);
  assert.throws(() => mediaDeliveryFromEnv({ MEDIA_DELIVERY: "cdn", MEDIA_ORIGIN_BASE: ORIGIN,
    MEDIA_CDN_BASE: "http://media.example.com/cms/" }), /plain HTTPS base/);
  assert.throws(() => mediaDeliveryFromEnv({ MEDIA_DELIVERY: "cdn", MEDIA_ORIGIN_BASE: ORIGIN,
    MEDIA_CDN_BASE: "https://media.example.com/cms" }), /ending in/);
});

test("withMediaDelivery resolves every asset src and nothing else", () => {
  const snapshot = {
    tours: [{ coverImage: { src: `${ORIGIN}a.webp`, alt: `${ORIGIN}a.webp` }, gallery: [{ src: `${ORIGIN}b.webp`, alt: "" }] }],
    siteSettings: { hero: { video: { src: `${ORIGIN}hero.webm` } }, siteUrl: ORIGIN },
  };
  const resolved = withMediaDelivery(snapshot, cdn);
  assert.equal(resolved.tours[0]!.coverImage.src, `${CDN}a.webp`);
  assert.equal(resolved.tours[0]!.coverImage.alt, `${ORIGIN}a.webp`);
  assert.equal(resolved.tours[0]!.gallery[0]!.src, `${CDN}b.webp`);
  assert.equal(resolved.siteSettings.hero.video.src, `${CDN}hero.webm`);
  assert.equal(resolved.siteSettings.siteUrl, ORIGIN);
  assert.equal(snapshot.tours[0]!.coverImage.src, `${ORIGIN}a.webp`, "the baked snapshot is never mutated");
});
