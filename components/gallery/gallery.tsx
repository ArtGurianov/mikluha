"use client";

import * as React from "react";

import type { ImageAsset } from "@/lib/cms/types";

import { GalleryStrip } from "./gallery-strip";
import { Lightbox } from "./lightbox";

export function Gallery({ images, className }: { images: ImageAsset[]; className?: string }) {
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

  if (images.length === 0) return null;

  return (
    <>
      <GalleryStrip images={images} onSelect={setLightboxIndex} className={className} />
      <Lightbox
        images={images}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    </>
  );
}
