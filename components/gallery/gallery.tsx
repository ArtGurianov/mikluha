"use client";

import * as React from "react";

import type { ImageAsset } from "@/lib/cms/types";

import { GalleryStrip } from "./gallery-strip";
import { Lightbox } from "./lightbox";

interface GalleryProps {
  images: ImageAsset[];
  captions?: string[];
  className?: string;
}

export function Gallery({ images, captions, className }: GalleryProps) {
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

  if (images.length === 0) return null;

  return (
    <>
      <GalleryStrip images={images} captions={captions} onSelect={setLightboxIndex} className={className} />
      <Lightbox
        images={images}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    </>
  );
}
