import remarkParse from "remark-parse";
import { unified } from "unified";

/** Presentation only: the stored/hash-checked Markdown is never trimmed or rewritten. */
export function leadingLegalTitleOffset(markdown: string): number | null {
  const first = unified().use(remarkParse).parse(markdown).children[0];
  return first?.type === "heading" && first.depth === 1 ? first.position?.start.offset ?? null : null;
}
