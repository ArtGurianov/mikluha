/** Presentation ports, not Agent A's HTTP/hold contract. All amounts/deadlines arrive from the server. */
export type TouristField = {
  key: string;
  label: string;
  required: boolean;
  help?: string;
} & ({ type: "text" | "date"; maxLength?: number } | { type: "select"; options: Array<{ value: string; label: string }> });

export interface BookingQuote {
  ref: string;
  hash: string;
  participantCount: number;
  lines: Array<{ lineRef: string; label: string; amountLabel: string }>;
  totalLabel: string;
  paymentOptions: Array<{
    ref: string;
    kind: "DEPOSIT" | "FULL";
    amountLabel: string;
    remainingLabel: string;
    balanceDueLabel: string;
  }>;
}

export interface BookingPresentation {
  departureId: string;
  title: string;
  dateLabel: string;
  departureLabel: string;
  quote: BookingQuote;
  schedule: { timezone: string; depositUntilLabel: string; publicBookingUntilLabel: string };
  touristDataSchema: { ref: string; hash: string; ready: boolean; fields: TouristField[] };
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
    additionalDetails: Record<string, string>;
  }>;
  adultsOnlyConfirmed: boolean;
  pdConsentConfirmed: boolean;
  terms: { ref: string; hash: string };
  pdConsent: { ref: string; hash: string };
  quote: { ref: string; hash: string };
  touristDataSchema: { ref: string; hash: string };
  paymentChoiceRef: string;
  captchaToken: string;
}

/** Rejected means the adapter proved no booking was created. Exceptions are UNKNOWN. */
export type BookingOutcome =
  | { kind: "review"; reference: string }
  | { kind: "rejected"; code: "CAPTCHA_INVALID" | "CAPTCHA_UNAVAILABLE" | "RATE_LIMITED" | "NOT_ENOUGH_SEATS" | "SALES_CLOSED" | "FORM_INVALID" }
  | { kind: "unknown" };

/** Explicit whitelist; browser promo/query/autofill, totals and profile are never forwarded. */
export function bookingDraft(form: FormData, view: BookingPresentation, participantIds: number[], captchaToken: string): BookingDraft | null {
  const value = (name: string) => String(form.get(name) ?? "").trim();
  const paymentChoiceRef = value("paymentChoice");
  if (!view.touristDataSchema.ready || view.quote.participantCount !== participantIds.length || participantIds.length === 0
    || !view.quote.paymentOptions.some((option) => option.ref === paymentChoiceRef)) return null;
  return {
    departureId: view.departureId,
    contact: { email: value("email"), phone: value("phone") },
    passengers: participantIds.map((id) => ({
      fullName: value(`p${id}Name`), dateOfBirth: value(`p${id}Dob`), citizenship: value(`p${id}Citizenship`),
      document: { type: value(`p${id}DocType`), series: value(`p${id}DocSeries`), number: value(`p${id}DocNumber`) },
      additionalDetails: Object.fromEntries(view.touristDataSchema.fields.map((field) => [field.key, value(`p${id}Extra_${field.key}`)])),
    })),
    adultsOnlyConfirmed: value("adultsOnly") === "yes",
    pdConsentConfirmed: value("pdConsent") === "yes",
    terms: { ref: view.terms.ref, hash: view.terms.hash },
    pdConsent: { ref: view.pdConsent.ref, hash: view.pdConsent.hash },
    quote: { ref: view.quote.ref, hash: view.quote.hash },
    touristDataSchema: { ref: view.touristDataSchema.ref, hash: view.touristDataSchema.hash },
    paymentChoiceRef,
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
