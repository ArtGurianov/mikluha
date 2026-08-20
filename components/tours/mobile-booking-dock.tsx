import type { ReactNode } from "react";

export function MobileBookingDock({ children }: { children: ReactNode }) {
  return (
    <div data-mobile-booking-dock className="fixed inset-x-0 bottom-0 z-30 lg:hidden">
      {children}
    </div>
  );
}
