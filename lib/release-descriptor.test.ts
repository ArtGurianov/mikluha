import assert from "node:assert/strict";
import test from "node:test";
import { makeSiteReleaseDescriptor, parseSiteReleaseDescriptor } from "./release-descriptor";

test("code identity does not claim a baked legal release is active", () => {
  const descriptor = makeSiteReleaseDescriptor("a".repeat(40));
  assert.deepEqual(parseSiteReleaseDescriptor(JSON.parse(JSON.stringify(descriptor))), descriptor);
  assert.equal(descriptor.legalAuthority, "commerce");
  assert.equal("termsRef" in descriptor, false);
  assert.equal("pdConsentRef" in descriptor, false);
});

test("identity refuses mutable commits and legacy descriptors", () => {
  assert.throws(() => makeSiteReleaseDescriptor("main"), /RELEASE_SOURCE_COMMIT_INVALID/);
  assert.throws(() => parseSiteReleaseDescriptor({ schema: 1, service: "mikluha-site", sourceCommit: "a".repeat(40) }), /RELEASE_DESCRIPTOR_INVALID/);
});
