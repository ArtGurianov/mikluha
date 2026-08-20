"use client";

import { Button, type buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";

import { useBookingModal } from "./booking-provider";

interface BookingButtonProps extends VariantProps<typeof buttonVariants> {
  /** Every booking CTA must name the exact date it books. */
  departureId: string;
  label?: string;
  /** Renders the button but refuses the click — used to keep card footers the same height when there is nothing to book. */
  disabled?: boolean;
  className?: string;
}

export function BookingButton({
  departureId,
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
      onClick={() => open(departureId)}
    >
      {label}
    </Button>
  );
}
