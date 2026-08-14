"use client";

import { Button, type buttonVariants } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";

import { useBookingModal } from "./booking-provider";

interface BookingButtonProps extends VariantProps<typeof buttonVariants> {
  tourId?: string;
  label?: string;
  className?: string;
}

export function BookingButton({ tourId, label = "Забронировать место", variant, size, className }: BookingButtonProps) {
  const { open } = useBookingModal();

  return (
    <Button variant={variant} size={size} className={className} onClick={() => open(tourId)}>
      {label}
    </Button>
  );
}
