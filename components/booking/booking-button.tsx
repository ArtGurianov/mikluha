import { Button, buttonVariants } from "@/components/ui/button";
import { commerceBookingUrl } from "@/lib/booking";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";

interface BookingButtonProps extends VariantProps<typeof buttonVariants> {
  /** Every booking CTA must name the exact date it books. */
  departureId: string;
  commerceOrigin: string;
  label?: string;
  /** Renders the button but refuses the click — used to keep card footers the same height when there is nothing to book. */
  disabled?: boolean;
  className?: string;
}

export function BookingButton({
  departureId,
  commerceOrigin,
  label = "Забронировать место",
  disabled,
  variant,
  size,
  className,
}: BookingButtonProps) {
  if (disabled) return (
    <Button
      variant={variant}
      size={size}
      disabled={disabled}
      className={cn("font-semibold", className)}
    >
      {label}
    </Button>
  );

  return (
    <a
      href={commerceBookingUrl(commerceOrigin, departureId)}
      className={cn(buttonVariants({ variant, size }), "font-semibold", className)}
    >
      {label}
    </a>
  );
}
