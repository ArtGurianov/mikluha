"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Check, LockKeyhole, Plus, ShieldCheck } from "lucide-react";
import { bookingDraft, bookingPassengers, bookingRefusals } from "@/lib/native-checkout";
import type { BookingDraft, BookingOutcome, BookingPresentation, QuoteRefreshRequest } from "@/lib/native-checkout";
import { SmartCaptcha, type CaptchaWidget } from "./smartcaptcha";

const input = "mt-2 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-3 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary disabled:bg-muted";
const card = "min-w-0 rounded-2xl border border-border bg-card p-5 sm:p-7";
const action = "inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-secondary px-5 py-3 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-secondary/90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-secondary disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";

/** Client composition port. No fetch, native API URL, bank redirect or seat allocator lives here. */
export function NativeCheckout({ view: suppliedView, captcha, submit, refreshQuote }: {
  view: BookingPresentation;
  captcha?: CaptchaWidget;
  submit?: (draft: BookingDraft) => Promise<BookingOutcome>;
  /** Read-only quote operation: must never create a booking, hold or payment. */
  refreshQuote?: (request: QuoteRefreshRequest) => Promise<BookingPresentation>;
}) {
  const prefix = useId();
  const suppliedSnapshot = JSON.stringify(suppliedView);
  const [sourceSnapshot, setSourceSnapshot] = useState(suppliedSnapshot);
  const [view, setView] = useState(suppliedView);
  const [participants, setParticipants] = useState([1]);
  const nextParticipant = useRef(2);
  const proof = useRef<string | null>(null);
  const [hasProof, setHasProof] = useState(false);
  const [captchaRevision, setCaptchaRevision] = useState(0);
  const [status, setStatus] = useState<"editing" | "submitting" | "unknown" | "review" | "refresh_required">(() => view.session.recoveryRequired ? "unknown" : "editing");
  const [inputRevision, setInputRevision] = useState(view.quote.inputRevision);
  const currentInputRevision = useRef(inputRevision);
  const activeRefresh = useRef<string | null>(null);
  useEffect(() => () => { activeRefresh.current = null; }, [suppliedSnapshot]);
  const [refreshing, setRefreshing] = useState(false);
  // Adjust only this component's state before children render, preserving uncontrolled inputs.
  if (sourceSnapshot !== suppliedSnapshot) {
    setSourceSnapshot(suppliedSnapshot); setView(suppliedView); setRefreshing(false);
  }
  const formRef = useRef<HTMLFormElement>(null);
  const busy = useRef(false);
  const [notice, setNotice] = useState("");
  const [paymentChoice, setPaymentChoice] = useState<{ quoteRef: string; quoteHash: string; optionRef: string } | null>(null);
  const selectionContext = JSON.stringify([view.session.clientRequestId, view.quote, view.terms, view.pdConsent, view.touristDataSchema, inputRevision]);
  const [previousContext, setPreviousContext] = useState(selectionContext);
  if (previousContext !== selectionContext) { setPreviousContext(selectionContext); setPaymentChoice(null); }
  const quoteReady = status !== "refresh_required" && view.quote.participantCount === participants.length && view.quote.inputRevision === inputRevision;
  const selectedPayment = paymentChoice?.quoteRef === view.quote.ref && paymentChoice?.quoteHash === view.quote.hash
    ? view.quote.paymentOptions.find((option) => option.ref === paymentChoice.optionRef) : undefined;
  const noticeRef = useRef<HTMLDivElement>(null);
  const reportProof = useCallback((token: string | null) => {
    proof.current = token;
    setHasProof(Boolean(token));
  }, []);
  const retryCaptcha = useCallback(() => {
    reportProof(null);
    setCaptchaRevision((revision) => revision + 1);
  }, [reportProof]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || refreshing || status !== "editing" || view.session.recoveryRequired || !quoteReady || !submit || !proof.current) return;
    const draft = bookingDraft(new FormData(event.currentTarget), view, participants, proof.current, inputRevision);
    if (!draft || !selectedPayment || draft.paymentChoiceRef !== selectedPayment.ref) return;
    busy.current = true;
    activeRefresh.current = null;
    // Consume the proof before awaiting the server; a retry always needs a fresh widget/token.
    reportProof(null);
    setStatus("submitting");
    setNotice("");
    let outcome: BookingOutcome;
    try { outcome = await submit(draft); }
    catch { outcome = { kind: "unknown" }; }
    if (outcome.kind === "refresh_required") {
      setPaymentChoice(null);
      setStatus("refresh_required");
      setNotice("Цена, способы оплаты или документы изменились. Обновите условия, заново выберите платёж и подтвердите согласия.");
      busy.current = false;
    } else if (outcome.kind === "rejected" || outcome.kind === "not_dispatched") {
      setStatus("editing");
      setNotice(outcome.kind === "rejected" ? bookingRefusals[outcome.code] : "Запрос не был отправлен. Данные сохранены. Пройдите проверку безопасности и повторите отправку.");
      retryCaptcha();
      busy.current = false;
    } else if (outcome.kind === "review") {
      setStatus("review");
      setNotice(`Заявка ${outcome.reference} получена. Перед оплатой нужно проверить её условия. Эта страница не подтверждает оплату или бронирование.`);
    } else {
      setStatus("unknown");
      setNotice("Ответ на отправку не получен. Заявка могла быть создана. Не отправляйте её повторно: сначала уточните состояние у организатора.");
    }
    requestAnimationFrame(() => noticeRef.current?.focus());
  }

  const locked = !["editing", "refresh_required"].includes(status) || view.session.recoveryRequired;
  function invalidateInputs() {
    const revision = crypto.randomUUID();
    currentInputRevision.current = revision;
    setInputRevision(revision);
    setPaymentChoice(null);
    activeRefresh.current = null;
    setRefreshing(false);
    // Unconsumed CAPTCHA proof is independent of passenger data/quote; SDK expiry still clears it.
  }
  function changeParticipants(ids: number[]) {
    setParticipants(ids);
    invalidateInputs();
  }
  async function updateQuote() {
    if (!refreshQuote || locked || refreshing || activeRefresh.current || !formRef.current) return;
    const requestId = crypto.randomUUID();
    const revision = currentInputRevision.current;
    activeRefresh.current = requestId;
    setRefreshing(true);
    setPaymentChoice(null);
    try {
      const updated = await refreshQuote({ clientRequestId: view.session.clientRequestId, departureId: view.departureId,
        inputRevision: revision, passengers: bookingPassengers(new FormData(formRef.current), view, participants),
        touristDataSchema: { ref: view.touristDataSchema.ref, hash: view.touristDataSchema.hash } });
      if (activeRefresh.current !== requestId || currentInputRevision.current !== revision) return;
      if (updated.quote.inputRevision !== revision || updated.quote.participantCount !== participants.length
        || updated.departureId !== view.departureId || updated.session.clientRequestId !== view.session.clientRequestId
        || updated.session.recoveryRequired) throw new Error("QUOTE_CONTEXT_MISMATCH");
      setView(updated);
      setStatus("editing");
      setNotice("Условия обновлены. Проверьте их и выберите первый платёж.");
    } catch {
      if (activeRefresh.current === requestId) setNotice("Не удалось обновить условия. Данные сохранены. Повторите обновление или свяжитесь с организатором.");
    } finally {
      if (activeRefresh.current === requestId) { activeRefresh.current = null; setRefreshing(false); }
    }
  }
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-14">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-secondary"><ShieldCheck className="size-4" aria-hidden />Онлайн-бронирование</p>
      <h1 className="mt-4 max-w-3xl font-heading text-3xl font-semibold tracking-tight sm:text-5xl">Бронирование поездки</h1>
      <p className="mt-4 max-w-xl leading-relaxed text-muted-foreground">Укажите, кто едет с вами. Перед оплатой вы сможете проверить данные туристов и условия поездки.</p>
      <ol aria-label="Этапы бронирования" className="my-8 grid max-w-2xl grid-cols-3 gap-3 text-xs sm:my-10 sm:text-sm">
        {["Данные туристов", "Проверка заявки", "Оплата"].map((step, index) => (
          <li key={step} aria-current={index === 0 ? "step" : undefined} className={`border-t-2 pt-3 ${index === 0 ? "border-primary font-semibold" : "border-border text-muted-foreground"}`}>
            <span className="mr-2 tabular-nums">0{index + 1}</span>{step}
          </li>
        ))}
      </ol>
      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-10">
        <form ref={formRef} method="post" onSubmit={send} onChange={(event) => { const name = event.target.getAttribute("name") ?? ""; if (/^p\d/.test(name)) invalidateInputs(); }} className="grid min-w-0 gap-5" aria-label="Данные для бронирования" aria-busy={status === "submitting"}>
          <fieldset disabled={locked} className={card}>
            <legend className="px-2 text-lg font-semibold">Контакты заказчика</legend>
            <p className="mb-5 text-sm text-muted-foreground">Заказчик участвует в поездке как турист № 1. На email придут документы и чек.</p>
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="text-sm font-medium">Телефон<input className={input} name="phone" type="tel" autoComplete="tel" required maxLength={40} /></label>
              <label className="text-sm font-medium">Email<input className={input} name="email" type="email" autoComplete="email" required maxLength={254} /></label>
            </div>
          </fieldset>
          <p className="text-sm leading-relaxed text-muted-foreground">В первой заявке можно оформить нескольких взрослых. Для поездки с ребёнком нужна единая заявка с родителем или законным опекуном через <Link href="/#contacts" prefetch={false} className="text-secondary underline underline-offset-4">менеджера</Link>.</p>
          {participants.map((id, index) => (
            <fieldset key={id} disabled={locked} className={card}>
              <legend className="px-2 text-lg font-semibold">Турист {index + 1}{index === 0 ? " · Вы" : ""}</legend>
              <div className="grid gap-5 sm:grid-cols-2">
                <label className="text-sm font-medium sm:col-span-2">Фамилия, имя и отчество<input className={input} name={`p${id}Name`} autoComplete="off" maxLength={200} required /></label>
                <label className="text-sm font-medium">Дата рождения<input className={input} name={`p${id}Dob`} type="date" required /></label>
                <label className="text-sm font-medium">Гражданство (код страны)<input className={input} name={`p${id}Citizenship`} defaultValue="RU" list={`${prefix}-countries`} maxLength={2} minLength={2} pattern="[A-Za-z]{2}" autoComplete="off" required aria-describedby={`${prefix}-citizenship-${id}`} /></label>
                <p id={`${prefix}-citizenship-${id}`} className="text-xs text-muted-foreground sm:col-span-2">Например: RU — Россия, BY — Беларусь, KZ — Казахстан.</p>
                <label className="text-sm font-medium sm:col-span-2">Документ<select className={input} name={`p${id}DocType`}><option value="RU_PASSPORT">Паспорт гражданина РФ</option><option value="RU_INTERNATIONAL_PASSPORT">Заграничный паспорт гражданина РФ</option><option value="FOREIGN_DOCUMENT">Документ иностранного гражданина</option></select></label>
                <label className="text-sm font-medium">Серия<input className={input} name={`p${id}DocSeries`} autoComplete="off" maxLength={10} /></label>
                <label className="text-sm font-medium">Номер<input className={input} name={`p${id}DocNumber`} autoComplete="off" required maxLength={20} /></label>
                {view.touristDataSchema.ready && view.touristDataSchema.fields.map((field) => <label key={field.key} className="text-sm font-medium sm:col-span-2">{field.label}
                  {field.type === "select" ? <select className={input} name={`p${id}Extra_${field.key}`} required={field.required} defaultValue=""><option value="" disabled>Выберите значение</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                    : <input className={input} name={`p${id}Extra_${field.key}`} type={field.type} required={field.required} maxLength={field.maxLength} autoComplete="off" />}
                  {field.help && <span className="mt-1 text-xs font-normal text-muted-foreground">{field.help}</span>}
                </label>)}
              </div>
              {index > 0 && <button type="button" className="mt-5 rounded text-sm font-semibold text-secondary underline underline-offset-4" onClick={() => changeParticipants(participants.filter((item) => item !== id))}>Убрать туриста {index + 1}</button>}
            </fieldset>
          ))}
          <datalist id={`${prefix}-countries`}><option value="RU">Россия</option><option value="BY">Беларусь</option><option value="KZ">Казахстан</option><option value="KG">Кыргызстан</option><option value="AM">Армения</option><option value="AZ">Азербайджан</option><option value="UZ">Узбекистан</option><option value="TJ">Таджикистан</option><option value="TM">Туркменистан</option><option value="MD">Молдова</option><option value="GE">Грузия</option><option value="MN">Монголия</option><option value="CN">Китай</option></datalist>
          {participants.length < view.maxParticipants && <button type="button" disabled={locked} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-dashed border-secondary px-5 py-3 text-sm font-semibold text-secondary disabled:opacity-50" onClick={() => { const id = nextParticipant.current++; changeParticipants([...participants, id]); }}><Plus className="size-4" aria-hidden />Добавить взрослого туриста</button>}
          <fieldset disabled={locked || !quoteReady} className={`${card} space-y-3`}>
            <legend className="px-2 text-lg font-semibold">Первый платёж</legend>
            {view.quote.paymentOptions.map((option) => <label key={option.ref} className="flex items-start gap-3 rounded-xl border border-border p-4 text-sm">
              <input type="radio" name="paymentChoice" value={option.ref} required className="mt-1 size-4 shrink-0 accent-secondary" checked={selectedPayment?.ref === option.ref} onChange={() => setPaymentChoice({ quoteRef: view.quote.ref, quoteHash: view.quote.hash, optionRef: option.ref })} />
              <span><span className="block font-semibold">{option.kind === "DEPOSIT" ? "Предоплата" : "Полная оплата"} — {option.amountLabel}</span><span className="mt-1 block text-muted-foreground">Остаток: {option.remainingLabel}. {option.balanceDueLabel}</span></span>
            </label>)}
            <p className="text-xs leading-relaxed text-muted-foreground">Предоплата для новой заявки доступна до {view.schedule.depositUntilLabel}. Онлайн-оформление — до {view.schedule.publicBookingUntilLabel}. Часовой пояс: {view.schedule.timezone}.</p>
            {view.quote.paymentOptions.length > 0 && view.quote.paymentOptions.every((option) => option.kind === "FULL") && <p className="text-sm text-muted-foreground">Для этой заявки доступна только полная оплата.</p>}
            {view.quote.paymentOptions.length === 0 && <p role="status" className="text-sm">Онлайн-оформление закрыто. Свяжитесь с менеджером.</p>}
          </fieldset>
          <fieldset className={card}>
            <legend className="px-2 text-lg font-semibold">Промокод</legend>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
              <label className="w-full text-sm font-medium">Промокод<input disabled autoComplete="off" aria-describedby={`${prefix}-promo`} className={input} /></label>
              <button type="button" disabled aria-describedby={`${prefix}-promo`} className={action}>Применить</button>
            </div>
            <p id={`${prefix}-promo`} className="mt-4 text-sm leading-relaxed text-muted-foreground">Промокоды при онлайн-бронировании не принимаются. Цена в Заявке не зависит от промокода, и применить его после оформления или оплаты нельзя.</p>
          </fieldset>
          <fieldset key={JSON.stringify([view.session.clientRequestId, view.terms, view.pdConsent, view.touristDataSchema, inputRevision, status === "refresh_required"])} disabled={locked} className={`${card} space-y-4`}>
            <legend className="px-2 text-lg font-semibold">Перед отправкой</legend>
            <label className="flex items-start gap-3 text-sm leading-relaxed"><input className="mt-1 size-4 shrink-0 accent-secondary" type="checkbox" name="pdConsent" value="yes" required /><span>Я отдельно даю <a className="text-secondary underline underline-offset-4" href="/soglasie-pd/" target="_blank" rel="noreferrer">согласие на обработку персональных данных</a> в опубликованной редакции.</span></label>
            <label className="flex items-start gap-3 text-sm leading-relaxed"><input className="mt-1 size-4 shrink-0 accent-secondary" type="checkbox" name="adultsOnly" value="yes" required /><span>Все туристы совершеннолетние.</span></label>
            <p className="text-xs leading-relaxed text-muted-foreground">Данные туристов нужны для оформления и исполнения договора. Состав данных и основания обработки указаны в <a href="/privacy-policy/" target="_blank" rel="noreferrer" className="text-secondary underline">Политике обработки данных</a>. Условия договора — в <a href="/oferta/" target="_blank" rel="noreferrer" className="text-secondary underline">Публичной оферте</a>.</p>
          </fieldset>
          {!quoteReady && <p className="text-sm text-muted-foreground">Условия требуют обновления. Ожидаем обновлённые цены и условия оплаты.</p>}
          {!quoteReady && !locked && <button type="button" className={action} disabled={!refreshQuote || refreshing} onClick={updateQuote}>{refreshing ? "Обновляем условия…" : "Обновить условия"}</button>}
          {!view.touristDataSchema.ready && <p className="text-sm text-muted-foreground">Состав данных для оформления уточняется. Онлайн-отправка пока недоступна.</p>}
          {status === "editing" && !locked && <SmartCaptcha key={captchaRevision} widget={captcha} onProof={reportProof} onRetry={retryCaptcha} />}
          <div ref={noticeRef} tabIndex={-1} role="status" className={notice || status === "unknown" || view.session.recoveryRequired ? "rounded-xl border border-border bg-accent p-5 text-sm leading-relaxed outline-secondary" : "sr-only"}>{notice}{(status === "unknown" || view.session.recoveryRequired) && <p>Сначала уточните состояние заявки у организатора. Код обращения: {view.session.clientRequestId}. Перезагрузка страницы не разрешает повторную отправку.</p>}</div>
          {!submit && <p className="text-sm text-muted-foreground">Онлайн-отправка пока недоступна. Вы можете связаться с организатором.</p>}
          <button type="submit" disabled={!submit || !hasProof || locked || status !== "editing" || refreshing || !quoteReady || !view.touristDataSchema.ready || !selectedPayment} className={`${action} w-full`}>
            {status === "submitting" ? "Отправляем заявку…" : status === "unknown" ? "Нужно уточнить состояние заявки" : status === "review" ? "Заявка получена" : "Перейти к проверке заявки"}<ArrowRight className="size-4" aria-hidden />
          </button>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden />Отправка формы не списывает деньги. Оплата — после проверки Заявки.</p>
        </form>
        <aside aria-label="Ваша поездка" className="order-first min-w-0 lg:sticky lg:top-24 lg:order-last">
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="bg-accent p-6"><p className="text-xs font-semibold uppercase tracking-widest text-accent-foreground">Ваша поездка</p><h2 className="mt-3 text-2xl font-semibold tracking-tight">{view.title}</h2><p className="mt-4 text-sm">{view.dateLabel}</p><p className="mt-1 text-sm text-muted-foreground">{view.departureLabel}</p></div>
            {quoteReady ? <dl className="space-y-4 p-6">{view.quote.lines.map((line) => <div key={line.lineRef}><dt className="text-sm text-muted-foreground">{line.label}</dt><dd className="mt-1 font-semibold tabular-nums">{line.amountLabel}</dd></div>)}<div className="border-t border-border pt-5"><dt className="text-sm text-muted-foreground">Итого за заявку</dt><dd className="mt-1 text-3xl font-semibold tabular-nums">{view.quote.totalLabel}</dd></div>{selectedPayment && <div className="border-t border-border pt-5"><dt className="text-sm font-semibold">Первый платёж — {selectedPayment.amountLabel}</dt><dd className="mt-2 text-sm leading-relaxed text-muted-foreground">Остаток: {selectedPayment.remainingLabel}. {selectedPayment.balanceDueLabel}</dd></div>}</dl> : <p className="p-6 text-sm text-muted-foreground">Обновите стоимость заявки после изменения данных.</p>}
          </div>
          <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Check className="mt-0.5 size-4 shrink-0" aria-hidden />Наличие мест и условия бронирования проверим при отправке заявки.</p>
          <Link href="/#contacts" prefetch={false} className="mt-5 inline-block text-sm font-semibold text-secondary underline underline-offset-4">Связаться с организатором</Link>
        </aside>
      </div>
    </div>
  );
}
