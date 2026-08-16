#!/usr/bin/env tsx
/** Validate the shipped Sveltia configuration against the schema from the exact installed CMS version. */
import { readFile } from "node:fs/promises";
import path from "node:path";

import Ajv from "ajv";
import yaml from "js-yaml";

import { createAssetSourcePolicy, type CmsMediaConfig } from "../lib/cms/asset-source";
import { isStaging } from "../lib/site";

const ROOT = process.cwd();
const CONFIG_FILE = path.join(ROOT, "public/admin/config.yml");
const SCHEMA_FILE = path.join(ROOT, "node_modules/@sveltia/cms/schema/sveltia-cms.json");
const CONTENT_ASSETS_DIR = path.join(ROOT, "content/assets");

interface CmsConfig extends CmsMediaConfig {
  backend?: { auth_methods?: string[] };
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

async function main() {
  const [configText, schemaText] = await Promise.all([
    readFile(CONFIG_FILE, "utf-8"),
    readFile(SCHEMA_FILE, "utf-8"),
  ]);
  const config = yaml.load(configText) as CmsConfig;
  const schema = JSON.parse(schemaText) as object;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  const errors: string[] = [];

  if (!validate(config)) {
    for (const error of validate.errors ?? []) {
      const detail = error.params.additionalProperty
        ? ` (${String(error.params.additionalProperty)})`
        : "";
      errors.push(`${error.instancePath || "/"} ${error.message ?? "is invalid"}${detail}`);
    }
  }

  if (!isStaging && configText.includes("CHANGE-ME")) {
    errors.push(
      "production config still contains CHANGE-ME placeholders; fill in OAuth and S3 settings or use DEPLOY_ENV=staging",
    );
  }

  if (config.backend?.auth_methods?.length !== 1 || config.backend.auth_methods[0] !== "oauth") {
    errors.push("backend.auth_methods must be [oauth] so editors use the allowlisted OAuth broker, not browser-stored PATs");
  }

  if (config.field_defaults?.richtext?.editor_components?.includes("image") !== false) {
    errors.push("field_defaults.richtext.editor_components must exclude image so Markdown cannot bypass asset materialization");
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

  try {
    const policy = createAssetSourcePolicy(config, CONTENT_ASSETS_DIR);
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
