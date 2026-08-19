import { Gallery } from "@/components/gallery/gallery";
import type { ReviewDTO } from "@/lib/cms/types";

export function ReviewsSection({ reviews }: { reviews: ReviewDTO[] }) {
  if (reviews.length === 0) return null;

  return (
    <section id="reviews" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="mb-8 space-y-2">
        <h2 className="font-heading text-2xl font-semibold text-foreground sm:text-3xl">Отзывы</h2>
        <p className="max-w-2xl text-muted-foreground">Что участники пишут организатору после поездки.</p>
      </div>

      <Gallery images={reviews.map((r) => r.image)} captions={reviews.map((r) => r.authorName)} />
    </section>
  );
}
