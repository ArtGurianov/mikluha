/**
 * `JSON.stringify` does not escape `<`, so CMS-authored text containing the
 * literal substring `</script>` could prematurely close a JSON-LD <script>
 * tag and inject markup. Escaping `<` as < neutralizes that while
 * remaining valid JSON (script content, not HTML, so no other char needs it).
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
