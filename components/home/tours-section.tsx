import type { ContentSnapshot } from "@/lib/cms/types";
import { getListedTours, getNextDeparture } from "@/lib/tours";

import { TourCard } from "./tour-card";

export function ToursSection({ content, today }: { content: ContentSnapshot; today: string }) {
  const tours = getListedTours(content);

  return (
    <section id="tours" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="mb-8 space-y-2">
        <h2 className="font-heading text-2xl font-semibold text-foreground sm:text-3xl">Ближайшие поездки</h2>
        <p className="max-w-2xl text-muted-foreground">
          Небольшие группы, конкретные даты и понятный статус набора — без сюрпризов.
        </p>
      </div>

      {tours.length === 0 ? (
        <p className="text-muted-foreground">Направления скоро появятся.</p>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {tours.map((tour) => (
            <TourCard key={tour.id} tour={tour} nextDeparture={getNextDeparture(content, tour.id, today)} />
          ))}
        </div>
      )}
    </section>
  );
}
