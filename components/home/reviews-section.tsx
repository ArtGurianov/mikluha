"use client";

import * as React from "react";

import { Lightbox } from "@/components/gallery/lightbox";
import { CmsImage } from "@/components/media/cms-image";
import type { ReviewDTO } from "@/lib/cms/types";

export function ReviewsSection({ reviews }: { reviews: ReviewDTO[] }) {
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

  if (reviews.length === 0) return null;

  const images = reviews.map((r) => r.image);

  return (
    <section id="reviews" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="mb-8 space-y-2">
        <h2 className="font-heading text-2xl font-semibold text-foreground sm:text-3xl">Отзывы</h2>
        <p className="max-w-2xl text-muted-foreground">Что участники пишут организатору после поездки.</p>
      </div>

      <div className="columns-2 gap-4 sm:columns-3 lg:columns-4 [&>*]:mb-4">
        {reviews.map((review, index) => (
          <button
            key={review.id}
            type="button"
            onClick={() => setLightboxIndex(index)}
            className="block w-full overflow-hidden rounded-xl bg-muted"
          >
            <CmsImage
              image={review.image}
              className="aspect-[3/2] w-full object-cover transition-transform duration-300 hover:scale-105"
            />
            <p className="p-2 text-left text-xs text-muted-foreground">{review.authorName}</p>
          </button>
        ))}
      </div>

      <Lightbox
        images={images}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    </section>
  );
}
