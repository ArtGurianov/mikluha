import type { BookingPresentation } from "@/lib/native-checkout";

export type PreviewPolicy = "deposit-and-full" | "full-only" | "closed" | "capped" | "schema-pending";

/** Fixed synthetic quote responses, not a client price/deposit/cutoff calculator. */
const prices = ["18 000 ₽", "17 500 ₽", "19 000 ₽", "16 500 ₽"];
const amounts = [
  { total: "18 000 ₽", deposit: "5 000 ₽", remaining: "13 000 ₽" },
  { total: "35 500 ₽", deposit: "10 000 ₽", remaining: "25 500 ₽" },
  { total: "54 500 ₽", deposit: "15 000 ₽", remaining: "39 500 ₽" },
  { total: "71 000 ₽", deposit: "20 000 ₽", remaining: "51 000 ₽" },
];

export function previewBookingView(size = 1, policy: PreviewPolicy = "deposit-and-full"): BookingPresentation {
  const amount = amounts[size - 1];
  if (!amount) throw new Error("SYNTHETIC_PARTY_OUT_OF_RANGE");
  const capped = policy === "capped" && size === 1;
  const total = capped ? "6 000 ₽" : amount.total;
  const quoteRef = `PREVIEW-${policy}-${size}`;
  const full = { ref: `${quoteRef}-full`, kind: "FULL" as const, amountLabel: total, remainingLabel: "0 ₽", balanceDueLabel: "Доплата не требуется." };
  const deposit = { ref: `${quoteRef}-deposit`, kind: "DEPOSIT" as const, amountLabel: capped ? "4 000 ₽" : amount.deposit, remainingLabel: capped ? "2 000 ₽" : amount.remaining, balanceDueLabel: "Доплатить до 13 ноября, 09:00." };
  return {
    departureId: "preview-synthetic-departure", title: "Выходные в горах Алтая",
    dateLabel: "14–16 ноября · пример выезда", departureLabel: "Отправление из Новосибирска",
    maxParticipants: 4,
    schedule: { timezone: "Asia/Krasnoyarsk", depositUntilLabel: "11 ноября, 09:00", publicBookingUntilLabel: "13 ноября, 09:00" },
    quote: {
      ref: quoteRef, hash: `SYNTHETIC-HASH-${quoteRef}`, participantCount: size,
      lines: capped ? [
        { lineRef: "ticket-1", label: "Турист 1 · билет", amountLabel: "4 000 ₽" },
        { lineRef: "service-1", label: "Турист 1 · дополнительная услуга", amountLabel: "2 000 ₽" },
      ] : prices.slice(0, size).map((amountLabel, index) => ({ lineRef: `ticket-${index + 1}`, label: `Турист ${index + 1} · билет`, amountLabel })),
      totalLabel: total,
      paymentOptions: policy === "closed" ? [] : policy === "full-only" ? [full] : [deposit, full],
    },
    // The real additional EIS field list is still TOUR-80/84 input. Do not invent it in this lab.
    touristDataSchema: { ref: "SYNTHETIC-SCHEMA-NOT-LIVE", hash: "SYNTHETIC-SCHEMA-HASH", ready: policy !== "schema-pending", fields: [] },
    terms: { ref: "PREVIEW-ONLY", hash: "PREVIEW-ONLY" }, pdConsent: { ref: "PREVIEW-ONLY", hash: "PREVIEW-ONLY" },
  };
}
