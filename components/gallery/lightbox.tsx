"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";

import { CmsImage } from "@/components/media/cms-image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { ImageAsset } from "@/lib/cms/types";

interface LightboxProps {
  images: ImageAsset[];
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function Lightbox({ images, index, onIndexChange, onClose }: LightboxProps) {
  const isOpen = index !== null;
  const touchStartX = React.useRef<number | null>(null);

  const goTo = React.useCallback(
    (next: number) => {
      const total = images.length;
      onIndexChange(((next % total) + total) % total);
    },
    [images.length, onIndexChange],
  );

  React.useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") goTo((index ?? 0) - 1);
      if (event.key === "ArrowRight") goTo((index ?? 0) + 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, index, goTo]);

  if (!isOpen || index === null) {
    return null;
  }

  const image = images[index];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton
        // `dvh`, not `vh`: on iOS Safari `vh` is the *large* viewport (toolbars
        // hidden), so a `vh` height runs underneath the visible browser chrome
        // and hides the close button and the counter. The close button is
        // absolutely positioned against the padding box, so container padding
        // would not move it — it gets its own safe-area offset instead.
        className="flex h-[92dvh] w-[96vw] max-w-5xl flex-col items-center justify-center gap-0 rounded-lg border-none bg-black/95 p-0 pt-4 sm:max-w-5xl [&_[data-slot=dialog-close]]:top-[max(0.5rem,env(safe-area-inset-top))] [&_[data-slot=dialog-close]]:text-white [&_[data-slot=dialog-close]]:hover:bg-white/10 [&_[data-slot=dialog-close]]:hover:text-white"
        onTouchStart={(event) => {
          touchStartX.current = event.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(event) => {
          if (touchStartX.current === null) return;
          const delta = event.changedTouches[0].clientX - touchStartX.current;
          if (Math.abs(delta) > 40) goTo(index + (delta < 0 ? 1 : -1));
          touchStartX.current = null;
        }}
      >
        <DialogTitle className="sr-only">{image.alt || "Просмотр фотографии"}</DialogTitle>

        {/* `flex-1 min-h-0`, not `h-full`: as a sibling of the counter, a
            full-height image box always overflowed the container and pushed
            the counter off-screen. */}
        <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
          <CmsImage image={image} loading="eager" className="max-h-full max-w-full object-contain" />

          {images.length > 1 && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Предыдущее фото"
                className="absolute left-2 top-1/2 -translate-y-1/2 text-white hover:bg-white/10 hover:text-white"
                onClick={() => goTo(index - 1)}
              >
                <ChevronLeft className="size-6" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Следующее фото"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white hover:bg-white/10 hover:text-white"
                onClick={() => goTo(index + 1)}
              >
                <ChevronRight className="size-6" />
              </Button>
            </>
          )}
        </div>

        {images.length > 1 && (
          <p className="shrink-0 py-1.5 text-sm tabular-nums text-white/80">
            {index + 1} / {images.length}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
