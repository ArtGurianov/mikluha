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
 * iOS Safari autoplay needs all three of `muted`, `playsInline` and `autoPlay`
 * together: without `muted` it refuses outright, and without `playsInline` it
 * hijacks playback into the native fullscreen player.
 *
 * WebM is the only format the CMS accepts (see RUNBOOK.md), which sets the
 * floor at iOS 16.4 — the first version with WebM support. Older iOS keeps the
 * poster instead of the video; if that baseline ever has to move, this is the
 * place that needs an additional MP4 `<source>`.
 */
export function HeroMedia({ image, video }: { image: ImageAsset; video: VideoAsset }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    const query = window.matchMedia(REDUCED_MOTION_QUERY);

    const sync = () => {
      if (query.matches) {
        // Pause rather than hide: someone who turns the preference on
        // mid-playback keeps the frame they were already looking at, instead
        // of the hero jumping back to the poster.
        element.pause();
        return;
      }

      // The `<source media>` below means no source is selected at all while
      // reduced motion is on, so re-select one if the preference just flipped.
      if (!element.currentSrc) element.load();

      // The `autoPlay` attribute alone silently no-ops often enough on iOS
      // Safari — after hydration, on bfcache restore, in Low Power Mode — that
      // the play has to be reinforced imperatively. A rejection here just
      // means the browser still refuses (Low Power Mode, no user gesture);
      // that is an expected outcome, not an error worth logging, but it must
      // be caught so it isn't an unhandled rejection.
      element.play().catch(() => {});
    };

    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return (
    <>
      <CmsImage
        image={image}
        loading="eager"
        fetchPriority="high"
        className={`absolute inset-0 size-full object-cover transition-opacity duration-300 ${
          videoReady ? "opacity-0" : "opacity-100"
        }`}
      />
      <video
        ref={videoRef}
        className={`absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-300 ${
          videoReady ? "opacity-100" : ""
        }`}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        poster={image.src}
        aria-hidden="true"
        tabIndex={-1}
        onPlaying={() => setVideoReady(true)}
      >
        <source src={video.src} type="video/webm" media="(prefers-reduced-motion: no-preference)" />
      </video>
    </>
  );
}
