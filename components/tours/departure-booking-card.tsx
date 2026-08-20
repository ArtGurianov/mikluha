import { BookingButton } from "@/components/booking/booking-button";
import { DepartureStatusBadge } from "@/components/site/departure-status-badge";
import type { DepartureDTO } from "@/lib/cms/types";
import { formatRub } from "@/lib/format";
import { formatDepartureDateRange, formatDurationLabel } from "@/lib/tours";
import { cn } from "@/lib/utils";

interface DepartureBookingCardProps {
  departure?: DepartureDTO;
  compact?: boolean;
  className?: string;
}

function BookingAction({ departure, className }: { departure?: DepartureDTO; className?: string }) {
  if (!departure) return null;

  const isBookable = departure.bookingStatus === "OPEN";

  return (
    <BookingButton
      departureId={departure.id}
      disabled={!isBookable}
      label={isBookable ? "Забронировать место" : "Набор закрыт"}
      className={className}
    />
  );
}

export function DepartureBookingCard({ departure, compact = false, className }: DepartureBookingCardProps) {
  if (compact) {
    return (
      <aside
        aria-label="Ближайший выезд"
        className={cn(
          "border-y border-border bg-background/95 shadow-[0_-12px_30px_-20px_rgba(0,0,0,0.55)] backdrop-blur-md",
          className,
        )}
      >
        <div className="mx-auto max-w-6xl space-y-3 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          {departure ? (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Ближайший выезд</p>
                <p className="font-heading truncate text-base font-semibold text-foreground">
                  {formatDepartureDateRange(departure.startDate, departure.endDate)}
                </p>
              </div>
              <DepartureStatusBadge status={departure.bookingStatus} className="mt-0.5 shrink-0" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Дата следующего тура скоро появится</p>
          )}

          <div className="flex items-center justify-between gap-3">
            {departure?.price !== undefined ? (
              <p className="min-w-0 leading-tight">
                <span className="font-heading block text-xl font-semibold tracking-tight text-foreground tabular-nums">
                  {formatRub(departure.price)}
                </span>
                <span className="text-xs text-muted-foreground">за человека</span>
              </p>
            ) : (
              <p className="text-sm font-medium text-muted-foreground">
                {departure ? "Цену уточняйте" : "Цена появится вместе с датой"}
              </p>
            )}
            <BookingAction departure={departure} className="h-11 min-w-40 px-4 text-base" />
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className={cn("h-fit overflow-hidden rounded-xl border border-border bg-card", className)}>
      <div className="space-y-4 p-6">
        {departure ? (
          <>
            <p className="text-sm text-muted-foreground">Ближайший выезд</p>
            <p className="font-heading text-lg font-semibold text-foreground">
              {formatDepartureDateRange(departure.startDate, departure.endDate)}
            </p>
            <p className="text-sm text-muted-foreground">
              {formatDurationLabel(departure.startDate, departure.endDate)}
            </p>
            <DepartureStatusBadge status={departure.bookingStatus} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Дата следующего тура скоро появится</p>
        )}
      </div>

      <div className="border-t border-border bg-muted/40 p-6">
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
        <BookingAction departure={departure} className="mt-4 w-full" />
      </div>
    </aside>
  );
}
