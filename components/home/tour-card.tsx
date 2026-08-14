import Image from "next/image";
import Link from "next/link";

import { BookingButton } from "@/components/booking/booking-button";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DepartureStatusBadge } from "@/components/site/departure-status-badge";
import type { DepartureDTO, TourDTO } from "@/lib/cms/types";
import { formatDepartureDateRange } from "@/lib/tours";
import { cn } from "@/lib/utils";

export function TourCard({ tour, nextDeparture }: { tour: TourDTO; nextDeparture?: DepartureDTO }) {
  return (
    <Card className="flex flex-col overflow-hidden py-0">
      <Link href={`/tours/${tour.slug}/`} className="relative block aspect-[4/3] w-full overflow-hidden bg-muted">
        <Image
          src={tour.coverImage.variants.card}
          alt={tour.coverImage.alt}
          fill
          sizes="(max-width: 768px) 100vw, 33vw"
          className="object-cover transition-transform duration-300 hover:scale-105"
        />
      </Link>

      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="space-y-1.5">
          <h3 className="font-heading text-xl font-semibold text-foreground">
            <Link href={`/tours/${tour.slug}/`}>{tour.title}</Link>
          </h3>
          <p className="text-sm text-muted-foreground">{tour.shortDescription}</p>
        </div>

        <div className="mt-auto space-y-2 pt-2">
          {nextDeparture ? (
            <>
              <p className="text-sm text-muted-foreground">
                Следующий тур
                <br />
                <span className="text-base font-medium text-foreground">
                  {formatDepartureDateRange(nextDeparture.startDate, nextDeparture.endDate)}
                </span>
              </p>
              <DepartureStatusBadge status={nextDeparture.bookingStatus} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Дата следующего тура скоро появится</p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Link href={`/tours/${tour.slug}/`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              Подробнее
            </Link>
            <BookingButton tourId={tour.id} size="sm" />
          </div>
        </div>
      </div>
    </Card>
  );
}
