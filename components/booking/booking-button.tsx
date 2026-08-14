"use client";

import { Button, type buttonVariants } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";

import { useBookingModal } from "./booking-provider";

interface BookingButtonProps extends VariantProps<typeof buttonVariants> {
  /** Books this exact date. Takes precedence over `tourId`. */
  departureId?: string;
  tourId?: string;
  label?: string;
  className?: string;
}

export function BookingButton({
  departureId,
  tourId,
  label = "Забронировать место",
  variant,
  size,
  className,
}: BookingButtonProps) {
  const { open } = useBookingModal();

  return (
    <Button variant={variant} size={size} className={className} onClick={() => open({ departureId, tourId })}>
      {label}
    </Button>
  );
}
