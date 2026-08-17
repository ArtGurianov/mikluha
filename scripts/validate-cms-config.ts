#!/usr/bin/env tsx
/** Validate the shipped Sveltia configuration against the schema from the exact installed CMS version. */
import { readFile } from "node:fs/promises";
import path from "node:path";

import Ajv from "ajv";
import yaml from "js-yaml";

import { createAssetSourcePolicy, type CmsMediaConfig } from "../lib/cms/asset-source";
import { configForSveltiaSchema, type SveltiaSchema } from "../lib/cms/sveltia-schema";
import { isStaging } from "../lib/site";

const ROOT = process.cwd();
const CONFIG_FILE = path.join(ROOT, "public/admin/config.yml");
const SCHEMA_FILE = path.join(ROOT, "node_modules/@sveltia/cms/schema/sveltia-cms.json");
const IMAGE_ACCEPT = ".webp,image/webp";
const VIDEO_ACCEPT = ".webm,video/webm";
const IMAGE_MAX_BYTES = 1024 * 1024;
const VIDEO_MAX_BYTES = 10 * 1024 * 1024;

interface CmsConfig extends CmsMediaConfig {
  backend?: { auth_methods?: string[]; base_url?: string; site_domain?: string };
  collections?: Array<{ fields?: unknown[] }>;
  field_defaults?: { richtext?: { editor_components?: string[] } };
  singletons?: Array<{ fields?: unknown[] }>;
}

function collectFields(fields: unknown[], result: Array<Record<string, unknown>>) {
  for (const value of fields) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const field = value as Record<string, unknown>;
    result.push(field);
    if (Array.isArray(field.fields)) collectFields(field.fields, result);
    if (field.field && typeof field.field === "object") collectFields([field.field], result);
  }
}

function fieldMediaMax(field: Record<string, unknown>): number | undefined {
  const mediaLibrary = field.media_library;
  if (!mediaLibrary || typeof mediaLibrary !== "object" || Array.isArray(mediaLibrary)) return undefined;
  const config = (mediaLibrary as Record<string, unknown>).config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const value = (config as Record<string, unknown>).max_file_size;
  return typeof value === "number" ? value : undefined;
}

async function main() {
  const [configText, schemaText] = await Promise.all([
    readFile(CONFIG_FILE, "utf-8"),
    readFile(SCHEMA_FILE, "utf-8"),
  ]);
  const config = yaml.load(configText) as CmsConfig;
  const schema = JSON.parse(schemaText) as SveltiaSchema;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  const errors: string[] = [];

  if (!validate(configForSveltiaSchema(config, schema))) {
    for (const error of validate.errors ?? []) {
      const detail = error.params.additionalProperty
        ? ` (${String(error.params.additionalProperty)})`
        : "";
      errors.push(`${error.instancePath || "/"} ${error.message ?? "is invalid"}${detail}`);
    }
  }

  if (!isStaging && configText.includes("CHANGE-ME")) {
    errors.push(
      "production config still contains CHANGE-ME placeholders; fill in the S3 settings or use DEPLOY_ENV=staging",
    );
  }

  if (config.backend?.auth_methods?.length !== 1 || config.backend.auth_methods[0] !== "token") {
    errors.push("backend.auth_methods must be [token] so the static CMS uses direct GitHub PAT authentication");
  }
  if (config.backend?.base_url || config.backend?.site_domain) {
    errors.push("backend.base_url and backend.site_domain must be absent; this deployment has no OAuth broker");
  }

  if (config.field_defaults?.richtext?.editor_components?.includes("image") !== false) {
    errors.push(
      "field_defaults.richtext.editor_components must exclude image; MarkdownContent and validate:out enforce the asset boundary",
    );
  }

  if (config.media_libraries?.aws_s3?.acl !== false) {
    errors.push(
      "media_libraries.aws_s3.acl must be false so uploads do not send x-amz-acl: public-read to an ACL-disabled bucket",
    );
  }

  if (config.media_libraries?.all?.max_file_size !== VIDEO_MAX_BYTES) {
    errors.push(`media_libraries.all.max_file_size must be ${VIDEO_MAX_BYTES} (10 MiB)`);
  }

  const fields: Array<Record<string, unknown>> = [];
  for (const collection of [...(config.collections ?? []), ...(config.singletons ?? [])]) {
    collectFields(collection.fields ?? [], fields);
  }
  for (const field of fields.filter((candidate) => candidate.widget === "datetime")) {
    if (field.type !== "date") {
      errors.push(
        `datetime field "${String(field.name)}" must use type: date; custom Moment-style date_format tokens corrupt Day.js output`,
      );
    }
  }
  for (const field of fields.filter((candidate) => candidate.widget === "image")) {
    if (field.accept !== IMAGE_ACCEPT || field.choose_url !== false || fieldMediaMax(field) !== IMAGE_MAX_BYTES) {
      errors.push(
        `image field "${String(field.name)}" must accept only WebP, disable arbitrary URL entry, and cap uploads at 1 MiB`,
      );
    }
  }
  for (const field of fields.filter((candidate) => candidate.widget === "file")) {
    if (field.accept !== VIDEO_ACCEPT || field.choose_url !== false || fieldMediaMax(field) !== VIDEO_MAX_BYTES) {
      errors.push(
        `file field "${String(field.name)}" must accept only WebM, disable arbitrary URL entry, and cap uploads at 10 MiB`,
      );
    }
  }
  for (const field of fields.filter((candidate) => candidate.name === "gallery")) {
    if (field.widget !== "list" || field.max !== 10) {
      errors.push(`gallery field must be a list capped at 10 images`);
    }
  }

  try {
    const policy = createAssetSourcePolicy(config);
    if (policy.remoteBases.length === 0) errors.push("no usable aws_s3 public_url or endpoint/bucket asset prefix is configured");
  } catch (error) {
    errors.push((error as Error).message);
  }

  if (errors.length > 0) {
    console.error(`[validate-cms-config] FAILED with ${errors.length} error(s):`);
    for (const error of errors) console.error(` - ${error}`);
    process.exit(1);
  }
  console.log("[validate-cms-config] OK — config matches the installed Sveltia schema and project invariants");
}

main().catch((error) => {
  console.error("[validate-cms-config] failed:", error);
  process.exit(1);
});
