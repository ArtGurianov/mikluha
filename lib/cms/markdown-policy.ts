import remarkParse from "remark-parse";
import { unified } from "unified";

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  identifier?: string;
  position?: { start: { line: number; column: number } };
  url?: string;
  value?: string;
}

export interface MarkdownPolicyViolation {
  column: number;
  kind: "image" | "html";
  line: number;
  subject: string;
}

const HTML_TAG_RE = /<[A-Za-z][A-Za-z0-9-]*(?=[\s/>])/;

/** Find unsupported rendered constructs while ignoring examples inside code. */
export function findMarkdownPolicyViolations(markdown: string): MarkdownPolicyViolation[] {
  const root = unified().use(remarkParse).parse(markdown) as MarkdownNode;
  const violations: MarkdownPolicyViolation[] = [];

  function visit(node: MarkdownNode) {
    const position = node.position?.start ?? { line: 1, column: 1 };
    if (node.type === "image" || node.type === "imageReference") {
      violations.push({
        ...position,
        kind: "image",
        subject: node.url ?? node.identifier ?? "unknown source",
      });
    } else if (node.type === "html") {
      const tag = node.value?.match(HTML_TAG_RE)?.[0];
      if (tag) violations.push({ ...position, kind: "html", subject: tag });
    }

    for (const child of node.children ?? []) visit(child);
  }

  visit(root);
  return violations;
}
