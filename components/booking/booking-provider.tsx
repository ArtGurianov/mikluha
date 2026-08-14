"use client";

import * as React from "react";

import type { BookingDepartureInfo, BookingFallback } from "./types";

interface BookingContextValue {
  isOpen: boolean;
  selected: BookingDepartureInfo | null;
  fallback: BookingFallback;
  open: (tourId?: string) => void;
  close: () => void;
}

const BookingContext = React.createContext<BookingContextValue | null>(null);

interface BookingModalProviderProps {
  children: React.ReactNode;
  /** Every OPEN, listed departure across the whole site, pre-resolved server-side. */
  departures: BookingDepartureInfo[];
  /** siteSettings.booking defaults, used when nothing OPEN can be found at all. */
  fallback: BookingFallback;
}

export function BookingModalProvider({ children, departures, fallback }: BookingModalProviderProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<BookingDepartureInfo | null>(null);

  const open = React.useCallback(
    (tourId?: string) => {
      const pool = tourId ? departures.filter((d) => d.tourId === tourId) : departures;
      const next = [...pool].sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null;
      setSelected(next);
      setIsOpen(true);
    },
    [departures],
  );

  const close = React.useCallback(() => setIsOpen(false), []);

  const value = React.useMemo(
    () => ({ isOpen, selected, fallback, open, close }),
    [isOpen, selected, fallback, open, close],
  );

  return <BookingContext.Provider value={value}>{children}</BookingContext.Provider>;
}

export function useBookingModal() {
  const ctx = React.useContext(BookingContext);
  if (!ctx) throw new Error("useBookingModal must be used within a BookingModalProvider");
  return ctx;
}
