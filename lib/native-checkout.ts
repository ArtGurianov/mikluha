/** Presentation ports, not Agent A's HTTP/hold contract. No price, profile or TTL in commands. */
export interface BookingPresentation {
  departureId: string;
  title: string;
  dateLabel: string;
  departureLabel: string;
  priceLabel: string;
  paymentLabel: string;
  paymentDetail: string;
  maxParticipants: number;
  terms: { ref: string; hash: string };
  pdConsent: { ref: string; hash: string };
}

export interface BookingDraft {
  departureId: string;
  contact: { email: string; phone: string };
  passengers: Array<{
    fullName: string;
    dateOfBirth: string;
    citizenship: string;
    document: { type: string; series: string; number: string };
  }>;
  adultsOnlyConfirmed: boolean;
  pdConsentConfirmed: boolean;
  terms: { ref: string; hash: string };
  pdConsent: { ref: string; hash: string };
  captchaToken: string;
}

/** Rejected means the adapter proved no booking was created. Exceptions are UNKNOWN. */
export type BookingOutcome =
  | { kind: "review"; reference: string }
  | { kind: "rejected"; code: "CAPTCHA_INVALID" | "CAPTCHA_UNAVAILABLE" | "RATE_LIMITED" | "NOT_ENOUGH_SEATS" | "SALES_CLOSED" | "FORM_INVALID" }
  | { kind: "unknown" };

/** Explicit whitelist; browser promo/query/autofill, totals and profile are never forwarded. */
export function bookingDraft(form: FormData, view: BookingPresentation, participantIds: number[], captchaToken: string): BookingDraft {
  const value = (name: string) => String(form.get(name) ?? "").trim();
  return {
    departureId: view.departureId,
    contact: { email: value("email"), phone: value("phone") },
    passengers: participantIds.map((id) => ({
      fullName: value(`p${id}Name`), dateOfBirth: value(`p${id}Dob`), citizenship: value(`p${id}Citizenship`),
      document: { type: value(`p${id}DocType`), series: value(`p${id}DocSeries`), number: value(`p${id}DocNumber`) },
    })),
    adultsOnlyConfirmed: value("adultsOnly") === "yes",
    pdConsentConfirmed: value("pdConsent") === "yes",
    terms: { ref: view.terms.ref, hash: view.terms.hash },
    pdConsent: { ref: view.pdConsent.ref, hash: view.pdConsent.hash },
    captchaToken,
  };
}

export const bookingRefusals = {
  CAPTCHA_INVALID: "Проверка безопасности не принята или устарела. Пройдите её ещё раз — данные формы остались на странице.",
  CAPTCHA_UNAVAILABLE: "Проверка безопасности временно недоступна. Подождите и повторите проверку — данные формы остались на странице.",
  RATE_LIMITED: "Слишком много попыток. Подождите перед повторной отправкой. Данные формы остались на странице.",
  NOT_ENOUGH_SEATS: "Не удалось забронировать столько мест. Уточните наличие у организатора или выберите другой выезд.",
  SALES_CLOSED: "Онлайн-бронирование сейчас закрыто. Свяжитесь с организатором.",
  FORM_INVALID: "Проверьте данные туристов и контакты, затем пройдите проверку безопасности ещё раз.",
} as const;
