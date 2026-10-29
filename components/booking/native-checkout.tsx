"use client";

import { useCallback, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Check, LockKeyhole, Plus, ShieldCheck } from "lucide-react";
import { bookingDraft, bookingRefusals } from "@/lib/native-checkout";
import type { BookingDraft, BookingOutcome, BookingPresentation } from "@/lib/native-checkout";
import type { CaptchaMount } from "@/lib/smartcaptcha-widget";
import { SmartCaptcha } from "./smartcaptcha";

const input = "mt-2 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-3 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary disabled:bg-muted";
const card = "min-w-0 rounded-2xl border border-border bg-card p-5 sm:p-7";
const action = "inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-secondary px-5 py-3 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-secondary/90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-secondary disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";

/** Client composition port. No fetch, native API URL, bank redirect or seat allocator lives here. */
export function NativeCheckout({ view, captcha, submit }: {
  view: BookingPresentation;
  captcha?: CaptchaMount;
  submit?: (draft: BookingDraft) => Promise<BookingOutcome>;
}) {
  const prefix = useId();
  const [participants, setParticipants] = useState([1]);
  const nextParticipant = useRef(2);
  const proof = useRef<string | null>(null);
  const [hasProof, setHasProof] = useState(false);
  const [captchaRevision, setCaptchaRevision] = useState(0);
  const [status, setStatus] = useState<"editing" | "submitting" | "unknown" | "review">("editing");
  const busy = useRef(false);
  const [notice, setNotice] = useState("");
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
    if (busy.current || status !== "editing" || !submit || !proof.current) return;
    busy.current = true;
    const draft = bookingDraft(new FormData(event.currentTarget), view, participants, proof.current);
    // Consume the proof before awaiting the server; a retry always needs a fresh widget/token.
    reportProof(null);
    setStatus("submitting");
    setNotice("");
    let outcome: BookingOutcome;
    try { outcome = await submit(draft); }
    catch { outcome = { kind: "unknown" }; }
    if (outcome.kind === "rejected") {
      setStatus("editing");
      setNotice(bookingRefusals[outcome.code]);
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

  const locked = status !== "editing";
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
        <form method="post" onSubmit={send} className="grid min-w-0 gap-5" aria-label="Данные для бронирования" aria-busy={status === "submitting"}>
          <fieldset disabled={locked} className={card}>
            <legend className="px-2 text-lg font-semibold">Контакты заказчика</legend>
            <p className="mb-5 text-sm text-muted-foreground">Заказчик участвует в поездке как турист № 1. На email придут документы и чек.</p>
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="text-sm font-medium">Телефон<input className={input} name="phone" type="tel" autoComplete="tel" required maxLength={40} /></label>
              <label className="text-sm font-medium">Email<input className={input} name="email" type="email" autoComplete="email" required maxLength={254} /></label>
            </div>
          </fieldset>
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
              </div>
              {index > 0 && <button type="button" className="mt-5 rounded text-sm font-semibold text-secondary underline underline-offset-4" onClick={() => setParticipants((ids) => ids.filter((item) => item !== id))}>Убрать туриста {index + 1}</button>}
            </fieldset>
          ))}
          <datalist id={`${prefix}-countries`}><option value="RU">Россия</option><option value="BY">Беларусь</option><option value="KZ">Казахстан</option><option value="KG">Кыргызстан</option><option value="AM">Армения</option><option value="AZ">Азербайджан</option><option value="UZ">Узбекистан</option><option value="TJ">Таджикистан</option><option value="TM">Туркменистан</option><option value="MD">Молдова</option><option value="GE">Грузия</option><option value="MN">Монголия</option><option value="CN">Китай</option></datalist>
          {participants.length < view.maxParticipants && <button type="button" disabled={locked} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-dashed border-secondary px-5 py-3 text-sm font-semibold text-secondary disabled:opacity-50" onClick={() => { const id = nextParticipant.current++; setParticipants((ids) => [...ids, id]); }}><Plus className="size-4" aria-hidden />Добавить туриста</button>}
          <fieldset className={card}>
            <legend className="px-2 text-lg font-semibold">Промокод</legend>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
              <label className="w-full text-sm font-medium">Промокод<input disabled autoComplete="off" aria-describedby={`${prefix}-promo`} className={input} /></label>
              <button type="button" disabled aria-describedby={`${prefix}-promo`} className={action}>Применить</button>
            </div>
            <p id={`${prefix}-promo`} className="mt-4 text-sm leading-relaxed text-muted-foreground">Промокоды при онлайн-бронировании не принимаются. Цена в Заявке не зависит от промокода, и применить его после оформления или оплаты нельзя.</p>
          </fieldset>
          <fieldset disabled={locked} className={`${card} space-y-4`}>
            <legend className="px-2 text-lg font-semibold">Перед отправкой</legend>
            <label className="flex items-start gap-3 text-sm leading-relaxed"><input className="mt-1 size-4 shrink-0 accent-secondary" type="checkbox" name="pdConsent" value="yes" required /><span>Я отдельно даю <a className="text-secondary underline underline-offset-4" href="/soglasie-pd/" target="_blank" rel="noreferrer">согласие на обработку персональных данных</a> в опубликованной редакции.</span></label>
            <label className="flex items-start gap-3 text-sm leading-relaxed"><input className="mt-1 size-4 shrink-0 accent-secondary" type="checkbox" name="adultsOnly" value="yes" required /><span>Все туристы совершеннолетние.</span></label>
            <p className="text-xs leading-relaxed text-muted-foreground">Данные туристов нужны для договора и ЕИС «Электронная путёвка». <a href="/privacy-policy/" target="_blank" rel="noreferrer" className="text-secondary underline">Политика обработки данных</a>. Условия договора — в <a href="/oferta/" target="_blank" rel="noreferrer" className="text-secondary underline">Публичной оферте</a>.</p>
          </fieldset>
          {status === "editing" && <SmartCaptcha key={captchaRevision} mount={captcha} onProof={reportProof} onRetry={retryCaptcha} />}
          {notice && <div ref={noticeRef} tabIndex={-1} role="status" className="rounded-xl border border-border bg-accent p-5 text-sm leading-relaxed outline-secondary">{notice}</div>}
          {!submit && <p role="status" className="text-sm text-muted-foreground">Онлайн-отправка пока недоступна. Вы можете связаться с организатором.</p>}
          <button type="submit" disabled={!submit || !hasProof || locked} className={`${action} w-full`}>
            {status === "submitting" ? "Отправляем заявку…" : status === "unknown" ? "Нужно уточнить состояние заявки" : status === "review" ? "Заявка получена" : "Перейти к проверке заявки"}<ArrowRight className="size-4" aria-hidden />
          </button>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden />Отправка формы не списывает деньги. Оплата — после проверки Заявки.</p>
        </form>
        <aside aria-label="Ваша поездка" className="order-first min-w-0 lg:sticky lg:top-24 lg:order-last">
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="bg-accent p-6"><p className="text-xs font-semibold uppercase tracking-widest text-accent-foreground">Ваша поездка</p><h2 className="mt-3 text-2xl font-semibold tracking-tight">{view.title}</h2><p className="mt-4 text-sm">{view.dateLabel}</p><p className="mt-1 text-sm text-muted-foreground">{view.departureLabel}</p></div>
            <dl className="space-y-5 p-6"><div><dt className="text-xs text-muted-foreground">За одного туриста</dt><dd className="mt-1 text-3xl font-semibold tabular-nums">{view.priceLabel}</dd></div><div className="border-t border-border pt-5"><dt className="text-sm font-semibold">{view.paymentLabel}</dt><dd className="mt-2 text-sm leading-relaxed text-muted-foreground">{view.paymentDetail}</dd></div></dl>
          </div>
          <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Check className="mt-0.5 size-4 shrink-0" aria-hidden />Наличие мест и условия бронирования проверим при отправке заявки.</p>
          <Link href="/#contacts" prefetch={false} className="mt-5 inline-block text-sm font-semibold text-secondary underline underline-offset-4">Связаться с организатором</Link>
        </aside>
      </div>
    </div>
  );
}
