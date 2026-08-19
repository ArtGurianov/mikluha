"use client";

import { Button, type buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";

import { useBookingModal } from "./booking-provider";

interface BookingButtonProps extends VariantProps<typeof buttonVariants> {
  /** Books this exact date. Takes precedence over `tourId`. */
  departureId?: string;
  tourId?: string;
  label?: string;
  /** Renders the button but refuses the click — used to keep card footers the same height when there is nothing to book. */
  disabled?: boolean;
  className?: string;
}

export function BookingButton({
  departureId,
  tourId,
  label = "Забронировать место",
  disabled,
  variant,
  size,
  className,
}: BookingButtonProps) {
  const { open } = useBookingModal();

  return (
    <Button
      variant={variant}
      size={size}
      disabled={disabled}
      className={cn("font-semibold", className)}
      onClick={() => open({ departureId, tourId })}
    >
      {label}
    </Button>
  );
}
