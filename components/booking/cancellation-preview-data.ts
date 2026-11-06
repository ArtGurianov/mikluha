import type { CancellationPresentation } from "@/lib/cancellation-request";

export type CancellationScenario = "voluntary-early" | "voluntary-late" | "whole-only" | "nothing-cancellable" | "final-amount";

/** Fixed synthetic responses, not a client refund/retained-cost calculator. All figures are labels. */
const reasonCategories: CancellationPresentation["reasonCategories"] = [
  { value: "VOLUNTARY", label: "Добровольный отказ" },
  { value: "ILLNESS", label: "Болезнь туриста (с медицинскими документами)" },
  { value: "SAFETY_THREAT", label: "Подтверждённая угроза безопасности" },
  { value: "OPERATOR_CHANGE", label: "Организатор не может исполнить тур на согласованных условиях" },
];

const policy = {
  ref: "otkaz-i-vozvrat", hash: "SYNTHETIC-POLICY-HASH", updatedAtLabel: "20.10.2026",
  href: "/otkaz-i-vozvrat/", refundsEmail: "refunds@mikluha-maklai.ru",
};

export function previewCancellationView(scenario: CancellationScenario = "voluntary-early"): CancellationPresentation {
  const money: CancellationPresentation["money"] = scenario === "final-amount"
    ? { paidLabel: "18 000 ₽", depositLabel: "5 000 ₽", balanceDueLabel: "0 ₽", retainedExpensesLabel: "3 200 ₽", indicativeRefundLabel: "14 800 ₽", indicative: false }
    : scenario === "voluntary-late"
      ? { paidLabel: "18 000 ₽", depositLabel: "5 000 ₽", balanceDueLabel: "0 ₽", retainedExpensesLabel: "уточняется", indicativeRefundLabel: "≈ 9 000 ₽", indicative: true }
      : { paidLabel: "18 000 ₽", depositLabel: "5 000 ₽", balanceDueLabel: "13 000 ₽", retainedExpensesLabel: "не подтверждены", indicativeRefundLabel: "≈ 17 100 ₽", indicative: true };

  const participants: CancellationPresentation["participants"] = scenario === "whole-only"
    ? []
    : [
        { participantRef: "seat-1", label: "Турист 1 · Вы", cancellable: scenario !== "nothing-cancellable" },
        { participantRef: "seat-2", label: "Турист 2 · И. И.", cancellable: scenario !== "nothing-cancellable" },
        { participantRef: "seat-3", label: "Турист 3 · П. С.", cancellable: false, unavailableReason: "Уже отменён ранее." },
      ];

  return {
    session: { clientRequestId: "SYNTHETIC-REQUEST-NOT-LIVE", recoveryRequired: false },
    orderRef: "PREVIEW-0001",
    title: "Выходные в горах Алтая",
    dateLabel: "14–16 ноября · пример выезда",
    departureLabel: "Отправление из Новосибирска",
    participants,
    wholeBookingOnly: scenario === "whole-only",
    money,
    policy,
    reasonCategories,
  };
}
