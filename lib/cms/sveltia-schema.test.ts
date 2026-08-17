import assert from "node:assert/strict";
import { test } from "node:test";

import { configForSveltiaSchema } from "./sveltia-schema";

const config = { media_libraries: { aws_s3: { acl: false, bucket: "bucket" } } } as const;

test("schema validation strips the runtime ACL option only from its cloned input", () => {
  const forValidation = configForSveltiaSchema(config, {
    definitions: { S3MediaLibrary: { properties: { bucket: { type: "string" } } } },
  });

  assert.equal(forValidation.media_libraries.aws_s3.acl, undefined);
  assert.equal(config.media_libraries.aws_s3.acl, false);
});

test("schema validation retains ACL once the installed schema supports it", () => {
  const forValidation = configForSveltiaSchema(config, {
    definitions: { S3MediaLibrary: { properties: { acl: { type: "boolean" } } } },
  });

  assert.equal(forValidation.media_libraries.aws_s3.acl, false);
});
