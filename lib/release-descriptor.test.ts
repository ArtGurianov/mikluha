import assert from "node:assert/strict";
import test from "node:test";

import { makeSiteReleaseDescriptor, parseSiteReleaseDescriptor } from "./release-descriptor";

test("site release descriptor binds one immutable commit to the two customer legal artifacts", () => {
  const descriptor = makeSiteReleaseDescriptor("a".repeat(40), [
    { id: "oferta", slug: "oferta", title: "Offer", content: "offer text", updatedAt: "2026-10-04" },
    { id: "soglasie-pd", slug: "soglasie-pd", title: "Consent", content: "consent text", updatedAt: "2026-10-04" },
  ]);
  assert.equal(descriptor.sourceCommit, "a".repeat(40));
  assert.equal(descriptor.termsRef, "oferta@2026-10-04");
  assert.match(descriptor.termsHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(parseSiteReleaseDescriptor(JSON.parse(JSON.stringify(descriptor))).pdConsentRef,
    "soglasie-pd@2026-10-04");
});

test("site release descriptor refuses a mutable or malformed identity", () => {
  assert.throws(() => makeSiteReleaseDescriptor("main", []), /RELEASE_SOURCE_COMMIT_INVALID/);
  assert.throws(() => parseSiteReleaseDescriptor({ schema: 1, service: "mikluha-site", sourceCommit: "a".repeat(40) }),
    /RELEASE_DESCRIPTOR_INVALID/);
});
