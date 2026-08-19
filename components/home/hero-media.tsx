"use client";

import { useState } from "react";

import { CmsImage } from "@/components/media/cms-image";
import type { ImageAsset, VideoAsset } from "@/lib/cms/types";

/**
 * The WebP poster is the initial paint (SSR-visible, eager/high-priority —
 * it's the page's LCP element) and stays mounted for the section's whole
 * lifetime. The WebM only crossfades over it once `onPlaying` confirms a
 * frame is actually on screen, not just downloaded — an `onLoadedData` fires
 * before the browser has decided to render anything, which risks a flash of
 * black video before playback actually starts. If the video never plays
 * (reduced motion never even requests it — see the `<source media>` below —
 * codec failure, network error, or plain slow load), the poster simply stays
 * put: there is no loading state that can invert into "site looks broken".
 */
export function HeroMedia({ image, video }: { image: ImageAsset; video: VideoAsset }) {
  const [videoReady, setVideoReady] = useState(false);

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
        className={`absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-300 motion-reduce:hidden ${
          videoReady ? "opacity-100" : ""
        }`}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
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
