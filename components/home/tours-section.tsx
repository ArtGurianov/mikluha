"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import type { TourDTO } from "@/lib/cms/types";
import type { UpcomingDeparture } from "@/lib/tours";
import { cn } from "@/lib/utils";

import { TripCard } from "./trip-card";

interface ToursSectionProps {
  /** Every future departure of every listed tour, soonest first. */
  upcoming: UpcomingDeparture[];
  /** Every listed tour — including ones with nothing scheduled, so they can still be filtered to. */
  tours: TourDTO[];
}

const ALL = "all";

export function ToursSection({ upcoming, tours }: ToursSectionProps) {
  const [selectedTourId, setSelectedTourId] = React.useState<string>(ALL);
  const stripRef = React.useRef<HTMLDivElement>(null);

  // Filtering to a destination with fewer cards leaves the strip scrolled into
  // empty space, so send it back to the start on every change.
  function selectTour(tourId: string) {
    setSelectedTourId(tourId);
    stripRef.current?.scrollTo({ left: 0, behavior: "smooth" });
  }

  const visible = selectedTourId === ALL ? upcoming : upcoming.filter((u) => u.tour.id === selectedTourId);

  // A destination with nothing scheduled still gets a card, so a filter never
  // lands on an empty strip. Under "Все" that means one placeholder per
  // unscheduled tour, after the real dates — if nothing at all is scheduled,
  // the strip is placeholders only, which is a valid state.
  const scheduledTourIds = new Set(visible.map((u) => u.tour.id));
  const placeholders = tours.filter(
    (t) => !scheduledTourIds.has(t.id) && (selectedTourId === ALL || t.id === selectedTourId),
  );

  if (tours.length === 0) {
    return (
      <section id="tours" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="font-heading text-2xl font-semibold text-foreground sm:text-3xl">Ближайшие поездки</h2>
        <p className="mt-2 text-muted-foreground">Направления скоро появятся.</p>
      </section>
    );
  }

  return (
    <section id="tours" className="py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mb-6 space-y-2">
          <h2 className="font-heading text-2xl font-semibold text-foreground sm:text-3xl">Ближайшие поездки</h2>
          <p className="max-w-2xl text-muted-foreground">
            Небольшие группы, конкретные даты и понятный статус набора — без сюрпризов.
          </p>
        </div>

        <div
          className="scrollbar-none -mx-4 mb-6 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
          role="group"
          aria-label="Фильтр по направлениям"
        >
          <FilterChip active={selectedTourId === ALL} onClick={() => selectTour(ALL)}>
            Все направления
          </FilterChip>
          {tours.map((tour) => (
            <FilterChip
              key={tour.id}
              active={selectedTourId === tour.id}
              onClick={() => selectTour(tour.id)}
            >
              {tour.title}
            </FilterChip>
          ))}
        </div>
      </div>

      <div
        ref={stripRef}
        className="scrollbar-none flex snap-x snap-mandatory gap-5 overflow-x-auto px-4 pb-2 sm:px-6 lg:mx-auto lg:max-w-[calc(72rem+1px)]"
      >
        {visible.map(({ departure, tour }) => (
          <TripCard key={departure.id} tour={tour} departure={departure} />
        ))}
        {placeholders.map((tour) => (
          <TripCard key={`placeholder-${tour.id}`} tour={tour} />
        ))}
      </div>
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      aria-pressed={active}
      onClick={onClick}
      className={cn("shrink-0 rounded-full", !active && "bg-background")}
    >
      {children}
    </Button>
  );
}
