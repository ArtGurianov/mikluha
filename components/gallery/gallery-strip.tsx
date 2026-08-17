"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";

import { CmsImage } from "@/components/media/cms-image";
import { Button } from "@/components/ui/button";
import type { ImageAsset } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

interface GalleryStripProps {
  images: ImageAsset[];
  onSelect: (index: number) => void;
  className?: string;
}

export function GalleryStrip({ images, onSelect, className }: GalleryStripProps) {
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
    if (!track) return;
    // Keep receiving move/up events for this pointer even if it leaves the
    // track bounds mid-drag (fast mouse movement, etc).
    track.setPointerCapture(event.pointerId);
    dragState.current = { startX: event.clientX, scrollLeft: track.scrollLeft, dragging: true, moved: false };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const state = dragState.current;
    const track = trackRef.current;
    if (!state?.dragging || !track) return;
    const delta = event.clientX - state.startX;
    if (Math.abs(delta) > 4) state.moved = true;
    track.scrollLeft = state.scrollLeft - delta;
  }

  function endDrag() {
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
            className="relative aspect-[4/3] w-[72%] shrink-0 snap-start overflow-hidden rounded-xl bg-muted sm:w-[42%] md:w-[30%] lg:w-[24%]"
            onClick={(event) => {
              if (dragState.current?.moved) {
                event.preventDefault();
                return;
              }
              onSelect(index);
            }}
          >
            <CmsImage image={image} className="absolute inset-0 size-full object-cover" />
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
