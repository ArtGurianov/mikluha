"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";

import { CmsImage } from "@/components/media/cms-image";
import { Button } from "@/components/ui/button";
import type { ImageAsset } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

interface GalleryStripProps {
  images: ImageAsset[];
  /** Optional per-image caption (e.g. a review's author name), parallel-indexed to `images`. */
  captions?: string[];
  onSelect: (index: number) => void;
  className?: string;
}

export function GalleryStrip({ images, captions, onSelect, className }: GalleryStripProps) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const dragState = React.useRef<{ startX: number; scrollLeft: number; dragging: boolean; moved: boolean } | null>(null);

  function scrollByCard(direction: 1 | -1) {
    const track = trackRef.current;
    if (!track) return;
    const card = track.querySelector<HTMLElement>("[data-gallery-item]");
    const amount = (card?.offsetWidth ?? track.clientWidth * 0.8) + 12;
    track.scrollBy({ left: amount * direction, behavior: "smooth" });
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const track = trackRef.current;
    // Touch and pen already scroll the track natively (and get implicit pointer
    // capture); drag-to-scroll is only needed for a mouse.
    if (!track || event.pointerType !== "mouse") return;
    dragState.current = { startX: event.clientX, scrollLeft: track.scrollLeft, dragging: true, moved: false };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = dragState.current;
    const track = trackRef.current;
    if (!state?.dragging || !track) return;
    const delta = event.clientX - state.startX;

    if (!state.moved) {
      if (Math.abs(delta) <= 4) return;
      state.moved = true;
      // Capture only once this is genuinely a drag, never on a plain click:
      // pointer capture retargets the following `click` to the capturing
      // element, so capturing up front stopped every click from ever reaching
      // the card button underneath. Here that retarget is what we want — it
      // suppresses the click that ends a drag.
      track.setPointerCapture(event.pointerId);
    }

    track.scrollLeft = state.scrollLeft - delta;
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const track = trackRef.current;
    if (track?.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    if (dragState.current) dragState.current.dragging = false;
  }

  return (
    <div className={cn("group/gallery relative", className)}>
      <div
        ref={trackRef}
        className="scrollbar-none flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth pb-1 select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {images.map((image, index) => (
          <button
            key={image.src + index}
            type="button"
            data-gallery-item
            className="w-[72%] shrink-0 snap-start text-left sm:w-[42%] md:w-[30%] lg:w-[24%]"
            onClick={(event) => {
              if (dragState.current?.moved) {
                event.preventDefault();
                return;
              }
              onSelect(index);
            }}
          >
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-muted">
              <CmsImage image={image} className="absolute inset-0 size-full object-cover" />
            </div>
            {captions?.[index] && <p className="p-2 text-xs text-muted-foreground">{captions[index]}</p>}
          </button>
        ))}
      </div>

      <div className="pointer-events-none absolute inset-y-0 -left-3 hidden items-center md:flex">
        <Button
          variant="secondary"
          size="icon"
          className="pointer-events-auto opacity-0 shadow-md transition-opacity group-hover/gallery:opacity-100"
          aria-label="Предыдущие фото"
          onClick={() => scrollByCard(-1)}
        >
          <ChevronLeft />
        </Button>
      </div>
      <div className="pointer-events-none absolute inset-y-0 -right-3 hidden items-center md:flex">
        <Button
          variant="secondary"
          size="icon"
          className="pointer-events-auto opacity-0 shadow-md transition-opacity group-hover/gallery:opacity-100"
          aria-label="Следующие фото"
          onClick={() => scrollByCard(1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
