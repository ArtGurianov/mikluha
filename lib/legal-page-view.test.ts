import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import test from "node:test";

import { LegalPageView } from "../components/site/legal-page-view";

test("both complete candidate bodies render one title without changing stored source bytes", () => {
  for (const file of ["privacy-policy", "cookies"]) {
    const content = readFileSync(`docs/legal/2026-10-30-ssr-admin/${file}.md`, "utf8");
    const before = createHash("sha256").update(content).digest("hex");
    const page = { id: file, slug: file, title: "CMS navigation title", content };
    const dom = new JSDOM(renderToStaticMarkup(createElement(LegalPageView, { page })));
    assert.equal(dom.window.document.querySelectorAll("h1").length, 1);
    assert.equal(dom.window.document.querySelector("h1")!.textContent, content.split("\n")[0]!.slice(2));
    assert.equal(page.content, content);
    assert.equal(createHash("sha256").update(page.content).digest("hex"), before);
    for (const table of dom.window.document.querySelectorAll("table")) {
      const region = table.parentElement!;
      assert.equal(region.getAttribute("role"), "region");
      assert.equal(region.getAttribute("tabindex"), "0");
      assert.ok(region.classList.contains("overflow-x-auto"));
      assert.ok(table.querySelectorAll('th[scope="col"]').length > 0);
    }
    dom.window.close();
  }
});

test("heading-free bodies, blank-prefixed titles and later top headings keep exactly one h1", () => {
  for (const content of ["Текст без заголовка\n\n## Раздел", "\n\n# Название\n\n# Ещё заголовок", "Название\n========\n\n# Другой заголовок", "Первый абзац\n\n# Поздний заголовок", "    # Пример кода"]) {
    const page = { id: "legal", slug: "legal", title: "Заголовок страницы", content, updatedAt: "2026-01-01" };
    const dom = new JSDOM(renderToStaticMarkup(createElement(LegalPageView, { page })));
    assert.equal(dom.window.document.querySelectorAll("h1").length, 1);
    assert.ok(dom.window.document.querySelector("header")!.textContent!.includes("Действует с:"));
    dom.window.close();
  }
});
