"use client";

import * as React from "react";

import type { BookingDepartureInfo, BookingFallback } from "./types";

/** What the visitor clicked: a specific date, a tour in general, or nothing in particular. */
export interface BookingTarget {
  departureId?: string;
  tourId?: string;
}

interface BookingContextValue {
  isOpen: boolean;
  selected: BookingDepartureInfo | null;
  fallback: BookingFallback;
  open: (target?: BookingTarget) => void;
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
    (target?: BookingTarget) => {
      // A card for one specific date books that date. A generic CTA ("Забронировать"
      // in the header, or on a tour page) has no date in mind, so it falls back to
      // the soonest bookable departure — of that tour if one was named, otherwise
      // of the whole site. A departureId that is not in `departures` means it is no
      // longer OPEN, in which case the modal shows contacts only rather than a
      // stale price.
      const byId = target?.departureId
        ? (departures.find((d) => d.id === target.departureId) ?? null)
        : null;
      if (byId) {
        setSelected(byId);
        setIsOpen(true);
        return;
      }

      const pool = target?.tourId ? departures.filter((d) => d.tourId === target.tourId) : departures;
      setSelected([...pool].sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null);
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
