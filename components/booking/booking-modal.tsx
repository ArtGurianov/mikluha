"use client";

import { Phone } from "lucide-react";
import Image from "next/image";

import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatRub, telHref } from "@/lib/format";
import { formatDepartureDateRange } from "@/lib/tours";
import { cn } from "@/lib/utils";

import { useBookingModal } from "./booking-provider";

export function BookingModal() {
  const { isOpen, selected, fallback, close } = useBookingModal();

  const prepaymentAmount = selected?.prepaymentAmount ?? fallback.prepaymentAmount;
  const qr = selected?.qr ?? fallback.qr;
  const organizerName = selected?.organizerName ?? fallback.organizerName;
  const organizerPhone = selected?.organizerPhone ?? fallback.organizerPhone;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle className="font-heading text-xl">Забронировать место</DialogTitle>
          {selected ? (
            <p className="text-base font-medium text-foreground">
              {selected.tourTitle}
              <br />
              <span className="text-muted-foreground">
                {formatDepartureDateRange(selected.startDate, selected.endDate)}
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Ближайшие даты уточняются — свяжитесь с организатором по телефону ниже.
            </p>
          )}
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {prepaymentAmount !== undefined && (
            <p className="text-center text-lg font-semibold">Предоплата — {formatRub(prepaymentAmount)}</p>
          )}

          {qr && (
            <div className="w-full max-w-56 overflow-hidden rounded-lg border border-border bg-white p-2">
              <Image
                src={qr.variants.gallery}
                alt={qr.alt || "QR-код для предоплаты"}
                width={qr.width}
                height={qr.height}
                className="h-auto w-full"
              />
            </div>
          )}

          <div className="w-full space-y-2 rounded-lg bg-muted p-4 text-center text-sm">
            <p className="text-muted-foreground">После предоплаты сообщите организатору{organizerName ? ` (${organizerName})` : ""}:</p>
            {organizerPhone ? (
              <a href={telHref(organizerPhone)} className="block text-base font-semibold text-foreground underline-offset-4 hover:underline">
                {organizerPhone}
              </a>
            ) : (
              <p className="text-muted-foreground">Телефон организатора уточняется</p>
            )}
          </div>

          {organizerPhone && (
            <a href={telHref(organizerPhone)} className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
              <Phone /> Позвонить организатору
            </a>
          )}

          <p className="text-center text-xs text-muted-foreground">
            Место считается забронированным после подтверждения организатором.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
