import yaml from "js-yaml";

/**
 * Parses Git-backed CMS content without YAML's implicit timestamp coercion.
 *
 * Sveltia may serialize a date-only `datetime` field as `2026-06-15`.
 * Under js-yaml's default schema that becomes a Date, while the normalized
 * content contract deliberately represents calendar dates as YYYY-MM-DD
 * strings. JSON_SCHEMA leaves date-looking scalars as strings and preserves
 * the JSON values this content model otherwise uses (null, booleans, numbers,
 * strings, arrays, and objects).
 */
export function loadContentYaml(raw: string): unknown {
  return yaml.load(raw, { schema: yaml.JSON_SCHEMA });
}
