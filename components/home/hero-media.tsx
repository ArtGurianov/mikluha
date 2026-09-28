"use client";

import { useEffect, useRef, useState } from "react";

import { CmsImage } from "@/components/media/cms-image";
import type { ImageAsset, VideoAsset } from "@/lib/cms/types";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * The WebP poster is the initial paint (SSR-visible, eager/high-priority —
 * it's the page's LCP element) and stays mounted for the section's whole
 * lifetime. The WebM only crossfades over it once `onPlaying` confirms a
 * frame is actually on screen, not just downloaded — an `onLoadedData` fires
 * before the browser has decided to render anything, which risks a flash of
 * black video before playback actually starts. If the video never plays
 * (reduced motion, codec failure, network error, iOS Low Power Mode refusing
 * to autoplay, or plain slow load), the poster simply stays put: there is no
 * loading state that can hang or invert into "site looks broken", so nothing
 * has to watch for `suspend` to bail out of a spinner.
 *
 * The WebM (up to 10 MB) never competes with the critical path: the element
 * ships with `preload="none"` and no `autoPlay`, so nothing is fetched while
 * the poster, CSS, JS and fonts load. Playback is started imperatively — after
 * the window `load` event for the above-the-fold instance, when scrolled near
 * for a `lazy` one. The poster is the LCP either way, so the only visible
 * difference is the video fading in a moment later.
 *
 * iOS Safari only plays inline, without a user gesture, when the video is
 * `muted` and `playsInline`: without `muted` it refuses outright, and without
 * `playsInline` it hijacks playback into the native fullscreen player.
 *
 * WebM is the only format the CMS accepts (see RUNBOOK.md), which sets the
 * floor at iOS 16.4 — the first version with WebM support. Older iOS keeps the
 * poster instead of the video; if that baseline ever has to move, this is the
 * place that needs an additional MP4 `<source>`.
 */
interface HeroMediaProps {
  image: ImageAsset;
  video: VideoAsset;
  /**
   * Wait until the section is nearly on screen before fetching the video, and
   * let the poster load lazily at normal priority instead of competing with
   * the page's real LCP image.
   * Set this on every instance below the fold: two eager `<video>` elements
   * sharing one `src` race each other on load and the HTTP cache cannot
   * collapse requests that start together, so the file is paid for twice.
   * Deferring the second one lets the first finish and be served from cache
   * instead — see the `Cache-Control` note in RUNBOOK.md, which is what makes
   * that reuse a contract rather than Chrome's heuristic freshness guess.
   */
  lazy?: boolean;
}

export function HeroMedia({ image, video, lazy = false }: HeroMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    // Set once the trigger (window load, or the section scrolling near) fired.
    let due = false;

    const start = () => {
      due = true;
      if (query.matches) return;

      // The `<source media>` below means no source is selected at all while
      // reduced motion is on, so re-select one if the preference just flipped.
      if (!element.currentSrc) element.load();

      // The only thing that starts playback: there is no `autoPlay` attribute,
      // which would override `preload="none"` and fetch during page load (and
      // silently no-ops often enough on iOS Safari anyway). A rejection just
      // means the browser still refuses (Low Power Mode, no user gesture);
      // that is an expected outcome, not an error worth logging, but it must
      // be caught so it isn't an unhandled rejection.
      element.play().catch(() => {});
    };

    const onPreferenceChange = () => {
      if (query.matches) {
        // Pause rather than hide: someone who turns the preference on
        // mid-playback keeps the frame they were already looking at, instead
        // of the hero jumping back to the poster.
        element.pause();
        return;
      }
      // Don't let a preference change pull a deferred video forward.
      if (due) start();
    };

    query.addEventListener("change", onPreferenceChange);

    let observer: IntersectionObserver | undefined;

    if (lazy) {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          start();
        },
        // Start a little before the section scrolls in, so playback has a
        // head start rather than beginning visibly late.
        { rootMargin: "200px" },
      );
      observer.observe(element);
    } else if (document.readyState === "complete") {
      start();
    } else {
      window.addEventListener("load", start, { once: true });
    }

    return () => {
      query.removeEventListener("change", onPreferenceChange);
      window.removeEventListener("load", start);
      observer?.disconnect();
    };
  }, [lazy]);

  return (
    <>
      <CmsImage
        image={image}
        loading={lazy ? "lazy" : "eager"}
        fetchPriority={lazy ? "auto" : "high"}
        className={`absolute inset-0 size-full object-cover transition-opacity duration-300 ${
          videoReady ? "opacity-0" : "opacity-100"
        }`}
      />
      <video
        ref={videoRef}
        className={`absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-300 ${
          videoReady ? "opacity-100" : ""
        }`}
        muted
        loop
        playsInline
        preload="none"
        // A `poster` is fetched as soon as the element exists, whatever the
        // <img> above says — so a lazy instance leaves it to the lazy <img>.
        poster={lazy ? undefined : image.src}
        aria-hidden="true"
        tabIndex={-1}
        onPlaying={() => setVideoReady(true)}
      >
        <source src={video.src} type="video/webm" media="(prefers-reduced-motion: no-preference)" />
      </video>
    </>
  );
}
