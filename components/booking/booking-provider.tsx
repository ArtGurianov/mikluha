"use client";

import * as React from "react";

import { selectBookingDeparture } from "@/lib/booking";

import type { BookingDepartureInfo } from "./types";

interface BookingContextValue {
  isOpen: boolean;
  selected: BookingDepartureInfo | null;
  open: (departureId: string) => void;
  close: () => void;
}

const BookingContext = React.createContext<BookingContextValue | null>(null);

interface BookingModalProviderProps {
  children: React.ReactNode;
  /** Every OPEN, listed departure across the whole site, pre-resolved server-side. */
  departures: BookingDepartureInfo[];
}

export function BookingModalProvider({ children, departures }: BookingModalProviderProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<BookingDepartureInfo | null>(null);

  const open = React.useCallback(
    (departureId: string) => {
      const departure = selectBookingDeparture(departures, departureId);
      if (!departure) return;

      setSelected(departure);
      setIsOpen(true);
    },
    [departures],
  );

  const close = React.useCallback(() => setIsOpen(false), []);

  const value = React.useMemo(
    () => ({ isOpen, selected, open, close }),
    [isOpen, selected, open, close],
  );

  return <BookingContext.Provider value={value}>{children}</BookingContext.Provider>;
}

export function useBookingModal() {
  const ctx = React.useContext(BookingContext);
  if (!ctx) throw new Error("useBookingModal must be used within a BookingModalProvider");
  return ctx;
}
