/** Presentation ports, not Agent A's HTTP/hold contract. All amounts/deadlines arrive from the server. */
export type TouristField = {
  key: string;
  label: string;
  required: boolean;
  /** Qualified by A/TOUR-80/84 before enabling a real quote adapter. Default: excluded. */
  priceAffecting?: boolean;
  help?: string;
} & ({ type: "text" | "date"; maxLength?: number } | { type: "select"; options: Array<{ value: string; label: string }> });

export interface BookingQuote {
  ref: string;
  hash: string;
  /** Echo of the current client input revision; count alone cannot correlate a quote. */
  inputRevision: string;
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
  /** Durable bootstrap supplied by A's session/recovery adapter, never minted on submit. */
  session: { clientRequestId: string; recoveryRequired: boolean };
  departureId: string;
  title: string;
  dateLabel: string;
  departureLabel: string;
  quote: BookingQuote;
  schedule: { timezone: string; depositUntilLabel: string; publicBookingUntilLabel: string };
  touristDataSchema: {
    ref: string; hash: string; ready: boolean; fields: TouristField[];
    priceAffectingBaseFields?: Array<"dateOfBirth" | "citizenship">;
  };
  maxParticipants: number;
  terms: { ref: string; hash: string };
  pdConsent: { ref: string; hash: string };
}

export interface BookingDraft {
  clientRequestId: string;
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
  quote: { ref: string; hash: string; inputRevision: string };
  touristDataSchema: { ref: string; hash: string };
  paymentChoiceRef: string;
  captchaToken: string;
}

export interface QuoteRefreshRequest {
  clientRequestId: string;
  departureId: string;
  inputRevision: string;
  participantCount: number;
  /** Absent unless the qualified schema explicitly requires these pricing inputs. No identity/document fields. */
  pricingInputs?: Array<{ dateOfBirth?: string; citizenship?: string; additionalDetails?: Record<string, string> }>;
  touristDataSchema: { ref: string; hash: string };
}

/** All non-UNKNOWN refusals prove no booking/hold was created; generic exceptions are UNKNOWN. */
export type BookingOutcome =
  | { kind: "review"; reference: string }
  | { kind: "refresh_required"; code: "QUOTE_STALE" | "TERMS_CHANGED" | "PAYMENT_OPTIONS_CHANGED" }
  | { kind: "not_dispatched" }
  | { kind: "rejected"; code: "CAPTCHA_INVALID" | "CAPTCHA_UNAVAILABLE" | "RATE_LIMITED" | "NOT_ENOUGH_SEATS" | "SALES_CLOSED" | "FORM_INVALID" }
  | { kind: "unknown" };

/** Explicit whitelist; browser promo/query/autofill, totals and profile are never forwarded. */
export function bookingPassengers(form: FormData, view: BookingPresentation, participantIds: number[]): BookingDraft["passengers"] {
  const value = (name: string) => String(form.get(name) ?? "").trim();
  return participantIds.map((id) => ({
    fullName: value(`p${id}Name`), dateOfBirth: value(`p${id}Dob`), citizenship: value(`p${id}Citizenship`),
    document: { type: value(`p${id}DocType`), series: value(`p${id}DocSeries`), number: value(`p${id}DocNumber`) },
    additionalDetails: Object.fromEntries(view.touristDataSchema.fields.map((field) => [field.key, value(`p${id}Extra_${field.key}`)])),
  }));
}

export function priceAffectingInputNames(view: BookingPresentation, participantIds: number[]): string[] {
  if (!view.touristDataSchema.ready) return [];
  const suffixes = [
    ...(view.touristDataSchema.priceAffectingBaseFields?.includes("dateOfBirth") ? ["Dob"] : []),
    ...(view.touristDataSchema.priceAffectingBaseFields?.includes("citizenship") ? ["Citizenship"] : []),
    ...view.touristDataSchema.fields.filter((field) => field.priceAffecting === true).map((field) => `Extra_${field.key}`),
  ];
  return participantIds.flatMap((id) => suffixes.map((suffix) => `p${id}${suffix}`));
}

/** Quote projection is independent of bookingPassengers: names, contacts and documents cannot enter it. */
export function quotePricingInputs(form: FormData, view: BookingPresentation, participantIds: number[]): Pick<QuoteRefreshRequest, "participantCount" | "pricingInputs"> {
  const base = view.touristDataSchema.priceAffectingBaseFields ?? [];
  const extra = view.touristDataSchema.fields.filter((field) => field.priceAffecting === true);
  if (!view.touristDataSchema.ready || (!base.includes("dateOfBirth") && !base.includes("citizenship") && extra.length === 0)) return { participantCount: participantIds.length };
  const value = (name: string) => String(form.get(name) ?? "").trim();
  return { participantCount: participantIds.length, pricingInputs: participantIds.map((id) => ({
    ...(base.includes("dateOfBirth") ? { dateOfBirth: value(`p${id}Dob`) } : {}),
    ...(base.includes("citizenship") ? { citizenship: value(`p${id}Citizenship`) } : {}),
    ...(extra.length ? { additionalDetails: Object.fromEntries(extra.map((field) => [field.key, value(`p${id}Extra_${field.key}`)])) } : {}),
  })) };
}

export function bookingDraft(form: FormData, view: BookingPresentation, participantIds: number[], captchaToken: string, inputRevision: string): BookingDraft | null {
  const value = (name: string) => String(form.get(name) ?? "").trim();
  const paymentChoiceRef = value("paymentChoice");
  if (!view.session.clientRequestId || view.session.recoveryRequired || !captchaToken || !view.touristDataSchema.ready
    || !inputRevision || view.quote.inputRevision !== inputRevision || view.quote.participantCount !== participantIds.length || participantIds.length === 0
    || value("adultsOnly") !== "yes" || value("pdConsent") !== "yes"
    || !view.quote.paymentOptions.some((option) => option.ref === paymentChoiceRef)) return null;
  return {
    clientRequestId: view.session.clientRequestId,
    departureId: view.departureId,
    contact: { email: value("email"), phone: value("phone") },
    passengers: bookingPassengers(form, view, participantIds),
    adultsOnlyConfirmed: value("adultsOnly") === "yes",
    pdConsentConfirmed: value("pdConsent") === "yes",
    terms: { ref: view.terms.ref, hash: view.terms.hash },
    pdConsent: { ref: view.pdConsent.ref, hash: view.pdConsent.hash },
    quote: { ref: view.quote.ref, hash: view.quote.hash, inputRevision },
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
