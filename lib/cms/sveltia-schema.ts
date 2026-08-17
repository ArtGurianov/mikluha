import type { CmsMediaConfig } from "./asset-source";

export interface SveltiaSchema {
  definitions?: {
    S3MediaLibrary?: { properties?: Record<string, unknown> };
  };
}

/**
 * Return an isolated config copy compatible with the installed Sveltia schema.
 * The runtime-only exception disappears automatically once the schema adds it.
 */
export function configForSveltiaSchema<T extends CmsMediaConfig>(config: T, schema: SveltiaSchema): T {
  const forValidation = structuredClone(config);
  const s3Properties = schema.definitions?.S3MediaLibrary?.properties;

  // Sveltia 0.191.1 reads `media_libraries.aws_s3.acl` at upload time and
  // sends `x-amz-acl: public-read` unless it is exactly false. Its shipped
  // JSON schema does not list the runtime option yet. Keep this exception
  // explicit instead of weakening Ajv's additional-property gate.
  if (!s3Properties || !("acl" in s3Properties)) {
    delete forValidation.media_libraries?.aws_s3?.acl;
  }

  return forValidation;
}
