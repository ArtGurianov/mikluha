import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownContent } from "../../components/site/markdown-content";

test("MarkdownContent rejects an image that bypassed asset materialization", () => {
  assert.throws(
    () => renderToStaticMarkup(createElement(MarkdownContent, { value: "![alt](local:photo.jpg)" })),
    /Unsupported inline Markdown image source "local:photo.jpg"/,
  );
});

test("MarkdownContent permits a materialized local image", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, { value: "![alt](/generated/cms/0123456789abcdef/card.webp)" }),
  );

  assert.match(html, /src="\/generated\/cms\/0123456789abcdef\/card\.webp"/);
});

test("MarkdownContent rejects traversal hidden behind the materialized prefix", () => {
  assert.throws(
    () =>
      renderToStaticMarkup(
        createElement(MarkdownContent, { value: "![alt](/generated/cms/../private/photo.webp)" }),
      ),
    /Unsupported inline Markdown image source/,
  );
});
