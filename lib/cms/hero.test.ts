import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Hero } from "../../components/home/hero";
import { HeroMedia } from "../../components/home/hero-media";
import type { SiteSettingsDTO } from "./types";

function settings(): SiteSettingsDTO {
  return {
    siteName: "Миклуха Маклай",
    siteUrl: "https://example.com",
    timezone: "Europe/Moscow",
    hero: {
      title: "Путешествия",
      image: { src: "/media/demo/hero.webp", alt: "Горы" },
      video: { src: "https://s3.example/cms/hero.webm" },
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

test("Hero always renders the WebM over its WebP poster, with reduced-motion fallback", () => {
  const html = renderToStaticMarkup(createElement(Hero, { siteSettings: settings() }));

  // `muted` + `playsInline` are what let iOS Safari start playback inline
  // without a gesture at all, rather than refusing or going fullscreen.
  assert.match(html, /<video[^>]*muted=""/);
  assert.match(html, /<video[^>]*loop=""/);
  assert.match(html, /<video[^>]*playsInline=""/);
  assert.match(html, /poster="\/media\/demo\/hero\.webp"/);
  // Reduced motion is handled by never selecting a source (and pausing at
  // runtime), so the video is simply never fetched for those readers.
  assert.match(
    html,
    /<source src="https:\/\/s3\.example\/cms\/hero\.webm" type="video\/webm" media="\(prefers-reduced-motion: no-preference\)"/,
  );
  assert.match(html, /bg-(?:gradient|linear)-to-\w+/);
});

test("before the video reports onPlaying, the poster is fully opaque and the video is invisible (no black flash)", () => {
  const html = renderToStaticMarkup(createElement(Hero, { siteSettings: settings() }));
  const [, imgClass] = html.match(/<img[^>]*class="([^"]*)"/) ?? [];
  const [, videoClass] = html.match(/<video[^>]*class="([^"]*)"/) ?? [];

  assert.ok(imgClass?.includes("opacity-100"), "poster should start fully opaque");
  assert.ok(!imgClass?.includes("opacity-0"), "poster should not start transparent");
  assert.ok(videoClass?.includes("opacity-0"), "video should start invisible until it's actually playing");
  assert.ok(!videoClass?.includes("opacity-100"), "video should not start opaque");
});

test("no HeroMedia fetches its video during page load: no autoPlay, preload none", () => {
  const props = { image: settings().hero.image, video: settings().hero.video };

  for (const html of [
    renderToStaticMarkup(createElement(HeroMedia, props)),
    renderToStaticMarkup(createElement(HeroMedia, { ...props, lazy: true })),
  ]) {
    // `autoPlay` would override `preload="none"` and pull up to 10 MB of WebM
    // into the critical path, competing with the poster (the LCP image).
    assert.doesNotMatch(html, /<video[^>]*autoPlay=""/);
    assert.match(html, /<video[^>]*preload="none"/);
    // Everything iOS inline playback depends on still has to be there.
    assert.match(html, /<video[^>]*muted=""/);
    assert.match(html, /<video[^>]*playsInline=""/);
  }
});

test("only the above-the-fold poster is fetched eagerly at high priority", () => {
  const props = { image: settings().hero.image, video: settings().hero.video };
  const eager = renderToStaticMarkup(createElement(HeroMedia, props));
  const lazy = renderToStaticMarkup(createElement(HeroMedia, { ...props, lazy: true }));

  assert.match(eager, /<img[^>]*loading="eager"/);
  assert.match(eager, /<img[^>]*fetchPriority="high"/);

  // Below the fold it must not compete with the page's own LCP image — and a
  // video `poster` would be fetched eagerly regardless of the <img>.
  assert.match(lazy, /<img[^>]*loading="lazy"/);
  assert.doesNotMatch(lazy, /fetchPriority="high"/);
  assert.doesNotMatch(lazy, /<video[^>]*poster=/);
});

test("the gradient overlay is layered after (on top of) both the poster and the video", () => {
  const html = renderToStaticMarkup(createElement(Hero, { siteSettings: settings() }));
  const videoEnd = html.indexOf("</video>");
  const gradientMatch = html.match(/bg-(?:gradient|linear)-to-\w+/);

  assert.ok(videoEnd !== -1 && gradientMatch && gradientMatch.index !== undefined && gradientMatch.index > videoEnd);
});
