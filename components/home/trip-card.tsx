import Link from "next/link";

import { BookingButton } from "@/components/booking/booking-button";
import { CmsImage } from "@/components/media/cms-image";
import { DepartureStatusBadge } from "@/components/site/departure-status-badge";
import { Card } from "@/components/ui/card";
import type { DepartureDTO, TourDTO } from "@/lib/cms/types";
import { formatRub } from "@/lib/format";
import { formatDepartureDateRange, formatDurationLabel } from "@/lib/tours";

interface TripCardProps {
  tour: TourDTO;
  /** Omitted for a destination that has no upcoming date yet — the card still links to the tour. */
  departure?: DepartureDTO;
}

/**
 * One card in the catalogue strip. It has two states on purpose rather than two
 * components: a destination without a scheduled date still gets a full-size,
 * clickable card so filtering never lands on an empty strip — it just says the
 * date and price are not known yet.
 *
 * The whole card is a link (a stretched pseudo-element on the title), so the
 * booking button has to sit above it in the stacking order to stay clickable.
 */
export function TripCard({ tour, departure }: TripCardProps) {
  const isBookable = departure?.bookingStatus === "OPEN";

  return (
    <Card className="group/card relative flex w-[82%] shrink-0 snap-start flex-col overflow-hidden py-0 transition-colors hover:border-foreground/25 sm:w-[46%] lg:w-[31%]">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        <CmsImage
          image={tour.coverImage}
          className="absolute inset-0 size-full object-cover transition-transform duration-300 group-hover/card:scale-105"
        />
        {departure && (
          <div className="absolute inset-x-0 top-0 flex justify-end p-3">
            <DepartureStatusBadge status={departure.bookingStatus} className="shadow-sm backdrop-blur-sm" />
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-5 pb-4">
        <div className="space-y-1.5">
          <h3 className="font-heading text-xl font-semibold text-foreground">
            {/* Stretched link: makes the entire card the click target. */}
            <Link href={`/tours/${tour.slug}/`} className="after:absolute after:inset-0">
              {tour.title}
            </Link>
          </h3>

          {departure ? (
            <>
              <p className="text-base font-medium text-foreground">
                {formatDepartureDateRange(departure.startDate, departure.endDate)}
              </p>
              <p className="text-sm text-muted-foreground">
                {formatDurationLabel(departure.startDate, departure.endDate)}
              </p>
            </>
          ) : (
            <p className="text-base font-medium text-muted-foreground">Дата следующего выезда уточняется</p>
          )}
        </div>

        <p className="line-clamp-2 text-sm text-muted-foreground">{tour.shortDescription}</p>
      </div>

      <div className="mt-auto border-t border-border bg-muted/40 p-5 pt-4">
        {departure?.price !== undefined ? (
          <p className="flex items-baseline gap-2">
            <span className="font-heading text-3xl font-semibold tracking-tight text-foreground tabular-nums">
              {formatRub(departure.price)}
            </span>
            <span className="text-sm text-muted-foreground">за человека</span>
          </p>
        ) : (
          <p className="text-base font-medium text-muted-foreground">
            {departure ? "Цену уточняйте у организатора" : "Цена станет известна вместе с датой"}
          </p>
        )}

        {/*
          Always rendered, disabled when there is nothing to book: dropping it
          made closed and undated cards shorter than the rest, so a row of
          cards no longer lined up along the bottom.
        */}
        <div className="relative z-10 mt-4">
          <BookingButton departureId={departure?.id} disabled={!isBookable} size="sm" />
        </div>
      </div>
    </Card>
  );
}
