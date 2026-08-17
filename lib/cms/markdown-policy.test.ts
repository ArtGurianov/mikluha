import assert from "node:assert/strict";
import { test } from "node:test";

import { findMarkdownPolicyViolations } from "./markdown-policy";

test("Markdown policy finds every rendered image and raw HTML node", () => {
  const markdown = [
    "![remote](https://example.com/image.jpg)",
    "![referenced][hero]",
    "",
    "[hero]: local:hero.jpg",
    '<img src="https://example.com/raw.jpg">',
  ].join("\n");

  assert.deepEqual(
    findMarkdownPolicyViolations(markdown).map(({ kind, line, subject }) => ({ kind, line, subject })),
    [
      { kind: "image", line: 1, subject: "https://example.com/image.jpg" },
      { kind: "image", line: 2, subject: "hero" },
      { kind: "html", line: 5, subject: "<img" },
    ],
  );
});

test("Markdown policy ignores image and HTML examples inside code", () => {
  const markdown = [
    "`![inline](https://example.com/image.jpg)`",
    "",
    "```html",
    '<img src="https://example.com/raw.jpg">',
    "```",
    "",
    "    ![indented](local:image.jpg)",
  ].join("\n");

  assert.deepEqual(findMarkdownPolicyViolations(markdown), []);
});
