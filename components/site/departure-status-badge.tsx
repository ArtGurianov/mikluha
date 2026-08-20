import { Badge } from "@/components/ui/badge";
import type { BookingStatus } from "@/lib/cms/types";
import { getBookingStatusLabel } from "@/lib/tours";
import { cn } from "@/lib/utils";

const statusClassName: Record<BookingStatus, string> = {
  ANNOUNCED: "bg-primary/10 text-primary",
  OPEN: "bg-accent text-accent-foreground",
  CLOSED: "bg-muted text-muted-foreground",
  CANCELLED: "bg-destructive/10 text-destructive",
};

export function DepartureStatusBadge({ status, className }: { status: BookingStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", statusClassName[status], className)}>
      <span aria-hidden className="text-[0.6rem]">
        ●
      </span>
      {getBookingStatusLabel(status)}
    </Badge>
  );
}
