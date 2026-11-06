/**
 * TOUR-32 · M6.5 customer cancellation/refund UX — presentation ports only.
 *
 * This owns the customer-facing *request* experience for voluntary cancellation and
 * refund of deposits, balances and documented retained expenses. It is NOT the refund
 * execution contract (TOUR-27 / ART-263) and carries no partner-reward / Refref claim
 * logic (deferred, TOUR-87 / N10). The copied v9 commission-threshold rules are deliberately
 * absent: eligibility, retained-cost quantification and any refund amount are decided by the
 * server under the published Правила отказа и возврата, never in the browser.
 *
 * As with native checkout, every money figure arrives from the server as a pre-formatted
 * label. The browser computes no refund percentage, retained cost, balance or eligibility,
 * and the draft forwards no amount, percentage, bank detail or partner field.
 */
export type CancellationReasonCategory = "VOLUNTARY" | "ILLNESS" | "SAFETY_THREAT" | "OPERATOR_CHANGE";

export interface CancellableParticipant {
  /** Stable allocation/participant reference supplied by the server; never derived from passenger PD. */
  participantRef: string;
  /** Server decides how much identity to reveal (e.g. "Турист 2 · И. И."). */
  label: string;
  /** The server states whether this seat can still be cancelled through the customer request. */
  cancellable: boolean;
  /** Shown when cancellable is false; e.g. already cancelled, fulfilled or operator-held. */
  unavailableReason?: string;
}

/**
 * Server-formatted money summary. Indicative figures reflect the voluntary settlement offer in
 * the published rules; they are not a fixed penalty, proof of expense, or a guaranteed amount,
 * and the legally due refund is determined separately from documented actual expenses.
 */
export interface CancellationMoneySummary {
  paidLabel: string;
  depositLabel: string;
  balanceDueLabel: string;
  retainedExpensesLabel: string;
  indicativeRefundLabel: string;
  /** True while the refund figure is an indicative voluntary offer rather than a final calculation. */
  indicative: boolean;
}

export interface CancellationPresentation {
  /** Durable bootstrap supplied by the integration's session/recovery adapter, never minted on submit. */
  session: { clientRequestId: string; recoveryRequired: boolean };
  orderRef: string;
  title: string;
  dateLabel: string;
  departureLabel: string;
  participants: CancellableParticipant[];
  /** The server may permit only a whole-booking request in some states; per-tourist choice is then hidden. */
  wholeBookingOnly: boolean;
  money: CancellationMoneySummary;
  /** Published refund-policy identity the request is made under, plus the human channels from the policy. */
  policy: { ref: string; hash: string; updatedAtLabel: string; href: string; refundsEmail: string };
  reasonCategories: Array<{ value: CancellationReasonCategory; label: string; help?: string }>;
}

export interface CancellationDraft {
  clientRequestId: string;
  orderRef: string;
  /** Customer (Заказчик) of record for the application, required by the published "Как отказаться". */
  applicant: { fullName: string };
  /** Either the whole booking, or a whitelisted subset of still-cancellable participant references. */
  scope: { wholeBooking: boolean; participantRefs: string[] };
  reason: { category: CancellationReasonCategory; details: string };
  contact: { email: string; phone: string };
  /** The customer acknowledged the indicative/legal-calculation nature before sending. */
  policyAcknowledged: boolean;
  policy: { ref: string; hash: string };
  captchaToken: string;
}

/** Every non-UNKNOWN outcome proves no cancellation/refund was executed; generic exceptions are UNKNOWN. */
export type CancellationOutcome =
  | { kind: "received"; reference: string }
  | { kind: "refresh_required"; code: "SCOPE_STALE" | "POLICY_CHANGED" | "ALREADY_REQUESTED" }
  | { kind: "not_dispatched" }
  | { kind: "rejected"; code: "CAPTCHA_INVALID" | "CAPTCHA_UNAVAILABLE" | "RATE_LIMITED" | "ORDER_NOT_FOUND" | "NOTHING_CANCELLABLE" | "FORM_INVALID" }
  | { kind: "unknown" };

/** References of the participants the customer selected that the server still reports as cancellable. */
export function selectedCancellableRefs(view: CancellationPresentation, selected: Iterable<string>): string[] {
  const chosen = new Set(selected);
  return view.participants.filter((p) => p.cancellable && chosen.has(p.participantRef)).map((p) => p.participantRef);
}

/** True when there is at least one still-cancellable seat (or a whole-booking-only request). */
export function canRequestCancellation(view: CancellationPresentation): boolean {
  return view.wholeBookingOnly || view.participants.some((p) => p.cancellable);
}

/**
 * Explicit whitelist. Browser-side amounts, percentages, retained-cost figures, bank/card details,
 * promo, partner, query/autofill extras and profile are never forwarded. Returns null when the draft
 * is incomplete or the selected scope contains nothing the server reports as cancellable.
 *
 * The cancellation scope is never taken from arbitrary form input: a whole-booking request exists
 * only where the server-supplied view permits it (`wholeBookingOnly`). Otherwise the request is
 * composed strictly from the still-cancellable participants the customer selected, so a forged
 * `scope` field cannot widen a per-tourist refusal into the whole booking.
 */
export function cancellationDraft(
  form: FormData,
  view: CancellationPresentation,
  selectedParticipantRefs: string[],
  captchaToken: string,
): CancellationDraft | null {
  const value = (name: string) => String(form.get(name) ?? "").trim();
  const wholeBooking = view.wholeBookingOnly;
  const participantRefs = wholeBooking ? [] : selectedCancellableRefs(view, selectedParticipantRefs);
  const fullName = value("customerName");
  const category = value("reasonCategory") as CancellationReasonCategory;
  const details = value("reasonDetails");
  if (
    !view.session.clientRequestId || view.session.recoveryRequired || !captchaToken ||
    value("policyAcknowledged") !== "yes" ||
    fullName.length < 1 || fullName.length > 300 ||
    !view.reasonCategories.some((option) => option.value === category) ||
    details.length < 1 || details.length > 2000 ||
    !value("email") || !value("phone") ||
    (!wholeBooking && participantRefs.length === 0)
  ) return null;
  return {
    clientRequestId: view.session.clientRequestId,
    orderRef: view.orderRef,
    applicant: { fullName },
    scope: { wholeBooking, participantRefs },
    reason: { category, details },
    contact: { email: value("email"), phone: value("phone") },
    policyAcknowledged: true,
    policy: { ref: view.policy.ref, hash: view.policy.hash },
    captchaToken,
  };
}

export const cancellationRefusals = {
  CAPTCHA_INVALID: "Проверка безопасности не принята или устарела. Пройдите её ещё раз — данные формы остались на странице.",
  CAPTCHA_UNAVAILABLE: "Проверка безопасности временно недоступна. Подождите и повторите проверку — данные формы остались на странице.",
  RATE_LIMITED: "Слишком много попыток. Подождите перед повторной отправкой. Данные формы остались на странице.",
  ORDER_NOT_FOUND: "Не удалось сопоставить заявление с заказом. Проверьте ссылку из письма или напишите на адрес возвратов.",
  NOTHING_CANCELLABLE: "По выбранным туристам отказ сейчас недоступен. Обновите страницу или напишите на адрес возвратов.",
  FORM_INVALID: "Проверьте выбранных туристов, причину отказа и контакт для ответа, затем пройдите проверку безопасности ещё раз.",
} as const;
