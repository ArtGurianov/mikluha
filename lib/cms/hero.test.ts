import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Hero } from "../../components/home/hero";
import type { SiteSettingsDTO } from "./types";

function settings(video = true): SiteSettingsDTO {
  return {
    siteName: "Миклуха Маклай",
    siteUrl: "https://example.com",
    timezone: "Europe/Moscow",
    hero: {
      title: "Путешествия",
      image: { src: "/media/demo/hero.webp", alt: "Горы" },
      video: video ? { src: "https://s3.example/cms/hero.webm" } : undefined,
    },
    booking: { isDemo: true },
    socials: {},
    company: {
      legalName: "ИП Тест",
      inn: "000000000000",
      ogrn: "000000000000000",
      phone: "+70000000000",
      isDemo: true,
    },
    seo: { title: "Тест", description: "Тест" },
    launchReady: false,
  };
}

test("Hero renders direct WebM over its WebP poster with reduced-motion fallback", () => {
  const html = renderToStaticMarkup(createElement(Hero, { siteSettings: settings() }));

  assert.match(html, /<video[^>]*autoPlay=""/);
  assert.match(html, /<video[^>]*muted=""/);
  assert.match(html, /<video[^>]*loop=""/);
  assert.match(html, /<video[^>]*playsInline=""/);
  assert.match(html, /poster="\/media\/demo\/hero\.webp"/);
  assert.match(html, /motion-reduce:hidden/);
  assert.match(
    html,
    /<source src="https:\/\/s3\.example\/cms\/hero\.webm" type="video\/webm" media="\(prefers-reduced-motion: no-preference\)"/,
  );
  assert.match(html, /bg-gradient-to-t from-black\/80 via-black\/30 to-black\/10/);
});

test("Hero remains an image-only static section when video is absent", () => {
  const html = renderToStaticMarkup(createElement(Hero, { siteSettings: settings(false) }));

  assert.doesNotMatch(html, /<video/);
  assert.match(html, /<img[^>]*src="\/media\/demo\/hero\.webp"/);
});
