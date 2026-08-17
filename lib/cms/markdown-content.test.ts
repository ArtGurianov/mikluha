import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownContent } from "../../components/site/markdown-content";

test("MarkdownContent rejects an image that bypasses structured CMS fields", () => {
  assert.throws(
    () => renderToStaticMarkup(createElement(MarkdownContent, { value: "![alt](local:photo.jpg)" })),
    /Unsupported inline Markdown image source "local:photo.jpg"/,
  );
});

test("MarkdownContent also rejects direct WebP references", () => {
  assert.throws(
    () =>
      renderToStaticMarkup(
        createElement(MarkdownContent, { value: "![alt](/media/demo/hero.webp)" }),
      ),
    /Unsupported inline Markdown image source/,
  );
});
