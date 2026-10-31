"use client";

import { useCallback, useRef, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Info, LockKeyhole, ShieldCheck } from "lucide-react";
import { cancellationDraft, cancellationRefusals, canRequestCancellation, selectedCancellableRefs } from "@/lib/cancellation-request";
import type { CancellationDraft, CancellationOutcome, CancellationPresentation } from "@/lib/cancellation-request";
import { SmartCaptcha, type CaptchaWidget } from "./smartcaptcha";

const input = "mt-2 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-3 text-base font-normal text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary disabled:bg-muted";
const card = "min-w-0 rounded-2xl border border-border bg-card p-5 sm:p-7";
const action = "inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-secondary px-5 py-3 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-secondary/90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-secondary disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";

/**
 * Client composition port for a customer cancellation/refund request.
 * No fetch, refund execution, amount calculation, bank redirect or partner claim lives here:
 * the request is composed and handed to the integration's adapter; the refund itself is TOUR-27.
 *
 * The interactive lifecycle (status, notice, consumed proof, in-flight guard) belongs to one
 * cancellation session for one order, so it is bound to a stable identity key: a genuine change of
 * session/order remounts the form and resets that lifecycle rather than carrying a prior "received"
 * or "unknown" state across to a different application.
 */
/** The basis the customer confirms against: whole-booking permission, cancellable seats, policy redaction. */
function confirmationBasis(view: CancellationPresentation): string {
  return JSON.stringify([view.wholeBookingOnly, view.participants.filter((p) => p.cancellable).map((p) => p.participantRef), view.policy.ref, view.policy.hash]);
}

export function CancellationRequest(props: {
  view: CancellationPresentation;
  captcha?: CaptchaWidget;
  submit?: (draft: CancellationDraft) => Promise<CancellationOutcome>;
}) {
  return <CancellationForm key={`${props.view.session.clientRequestId}:${props.view.orderRef}`} {...props} />;
}

function CancellationForm({ view: suppliedView, captcha, submit }: {
  view: CancellationPresentation;
  captcha?: CaptchaWidget;
  submit?: (draft: CancellationDraft) => Promise<CancellationOutcome>;
}) {
  const suppliedSnapshot = JSON.stringify(suppliedView);
  const [sourceSnapshot, setSourceSnapshot] = useState(suppliedSnapshot);
  const [view, setView] = useState(suppliedView);
  const proof = useRef<string | null>(null);
  const [hasProof, setHasProof] = useState(false);
  const [captchaRevision, setCaptchaRevision] = useState(0);
  const [status, setStatus] = useState<"editing" | "submitting" | "unknown" | "received" | "refresh_required">(() => view.session.recoveryRequired ? "unknown" : "editing");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const busy = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // Same-identity refresh (updated money/participants/policy). The key remount handles a changed
  // session or order; here we pick up new server data and prune selections it no longer allows. If
  // the basis the customer confirmed against changed — whole-booking permission, the set of
  // cancellable seats, or the policy redaction — the prior acknowledgement and CAPTCHA proof no
  // longer apply: we return to editing, drop the proof and require a fresh confirmation, so an
  // update can never promote a per-tourist request to the whole booking, or carry an acknowledgement
  // onto a new policy redaction, without the customer confirming again.
  if (sourceSnapshot !== suppliedSnapshot) {
    const confirmationChanged = confirmationBasis(view) !== confirmationBasis(suppliedView);
    setSourceSnapshot(suppliedSnapshot);
    setView(suppliedView);
    setSelected((current) => current.filter((ref) => suppliedView.participants.some((p) => p.participantRef === ref && p.cancellable)));
    if (confirmationChanged && (status === "editing" || status === "refresh_required")) {
      // Drop the prior proof: `send` is gated on hasProof, and the bumped key remounts a fresh
      // CAPTCHA, so the consumed token cannot be reused against the new confirmation basis.
      setStatus("editing");
      setHasProof(false);
      setCaptchaRevision((revision) => revision + 1);
      setNotice("Состав заказа или правила возврата обновились. Проверьте выбор, подтвердите ознакомление и пройдите проверку заново.");
    }
  }

  const reportProof = useCallback((token: string | null) => {
    proof.current = token;
    setHasProof(Boolean(token));
  }, []);
  const retryCaptcha = useCallback(() => {
    reportProof(null);
    setCaptchaRevision((revision) => revision + 1);
  }, [reportProof]);

  const locked = !["editing", "refresh_required"].includes(status) || view.session.recoveryRequired;
  const available = canRequestCancellation(view);
  const chosenRefs = selectedCancellableRefs(view, selected);
  const scopeReady = view.wholeBookingOnly || chosenRefs.length > 0;

  function toggle(participantRef: string) {
    setSelected((current) => current.includes(participantRef) ? current.filter((ref) => ref !== participantRef) : [...current, participantRef]);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || status !== "editing" || view.session.recoveryRequired || !submit || !hasProof || !proof.current || !scopeReady) return;
    const draft = cancellationDraft(new FormData(event.currentTarget), view, chosenRefs, proof.current);
    if (!draft) return;
    busy.current = true;
    // Consume the proof before awaiting the server; a retry always needs a fresh widget/token.
    reportProof(null);
    setStatus("submitting");
    setNotice("");
    let outcome: CancellationOutcome;
    try { outcome = await submit(draft); }
    catch { outcome = { kind: "unknown" }; }
    if (outcome.kind === "refresh_required") {
      setStatus("refresh_required");
      setNotice("Состояние заказа или правила возврата изменились. Обновите страницу и проверьте выбор ещё раз. Повторную отправку пока не делайте.");
      busy.current = false;
    } else if (outcome.kind === "rejected" || outcome.kind === "not_dispatched") {
      setStatus("editing");
      setNotice(outcome.kind === "rejected" ? cancellationRefusals[outcome.code] : "Заявление не было отправлено. Данные сохранены. Пройдите проверку безопасности и повторите отправку.");
      retryCaptcha();
      busy.current = false;
    } else if (outcome.kind === "received") {
      setStatus("received");
      setNotice(`Заявление ${outcome.reference} получено. Организатор зафиксирует дату и время получения, рассчитает законный возврат по подтверждённым расходам и сообщит дальнейшие действия. Эта страница не подтверждает сумму и не производит возврат.`);
    } else {
      setStatus("unknown");
      setNotice("Ответ на отправку не получен. Заявление могло быть принято. Не отправляйте его повторно: сначала уточните состояние у организатора.");
    }
    requestAnimationFrame(() => noticeRef.current?.focus());
  }

  const money = view.money;
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-14">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-secondary"><ShieldCheck className="size-4" aria-hidden />Отказ и возврат</p>
      <h1 className="mt-4 max-w-3xl font-heading text-3xl font-semibold tracking-tight sm:text-5xl">Отказ от поездки и возврат</h1>
      <p className="mt-4 max-w-2xl leading-relaxed text-muted-foreground">Вы можете отказаться от поездки целиком или по отдельным туристам. Отправка заявления не списывает и не возвращает деньги: организатор зафиксирует получение, рассчитает законный возврат и свяжется с вами.</p>

      <div className="mt-8 grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-10">
        <form ref={formRef} method="post" onSubmit={send} className="grid min-w-0 gap-5" aria-label="Заявление об отказе и возврате" aria-busy={status === "submitting"}>
          <div className={card}>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Заказ № {view.orderRef}</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">{view.title}</h2>
            <p className="mt-3 text-sm">{view.dateLabel}</p>
            <p className="mt-1 text-sm text-muted-foreground">{view.departureLabel}</p>
          </div>

          <fieldset disabled={locked} className={`${card} space-y-4`}>
            <legend className="px-2 text-lg font-semibold">Что отменяем</legend>
            {view.wholeBookingOnly ? (
              <p className="text-sm leading-relaxed text-muted-foreground">По этому заказу доступен только отказ от всей брони. Расчёт возврата выполняется по отменяемой части заказа.</p>
            ) : available ? (
              <>
                <p className="text-sm text-muted-foreground">Отметьте туристов, которых касается отказ. Отказ одного туриста из группового заказа рассчитывается по его части обязательства.</p>
                <ul className="space-y-3">
                  {view.participants.map((participant) => (
                    <li key={participant.participantRef}>
                      <label className={`flex items-start gap-3 rounded-xl border border-border p-4 text-sm ${participant.cancellable ? "" : "opacity-60"}`}>
                        <input type="checkbox" name="participant" value={participant.participantRef} disabled={!participant.cancellable} className="mt-1 size-4 shrink-0 accent-secondary" checked={selected.includes(participant.participantRef)} onChange={() => toggle(participant.participantRef)} />
                        <span><span className="block font-medium">{participant.label}</span>{!participant.cancellable && participant.unavailableReason && <span className="mt-1 block text-muted-foreground">{participant.unavailableReason}</span>}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p role="status" className="text-sm leading-relaxed">Онлайн-отказ по этому заказу сейчас недоступен. Напишите на <a className="text-secondary underline underline-offset-4" href={`mailto:${view.policy.refundsEmail}`}>{view.policy.refundsEmail}</a>.</p>
            )}
          </fieldset>

          <fieldset disabled={locked} className={`${card} space-y-4`}>
            <legend className="px-2 text-lg font-semibold">Причина отказа</legend>
            <label className="block text-sm font-medium">Основание
              <select className={input} name="reasonCategory" defaultValue="" required>
                <option value="" disabled>Выберите основание</option>
                {view.reasonCategories.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium">Пояснение
              <textarea className={input} name="reasonDetails" rows={4} required maxLength={2000} placeholder="Коротко опишите причину. Не указывайте данные паспортов, полные реквизиты карты или банковские коды." />
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">Особые основания (болезнь туриста, подтверждённая угроза безопасности, невозможность исполнения тура) рассматриваются по закону и индивидуальному расчёту, без автоматического удержания по шкале. Подтверждающие документы приложите в ответном письме, а не здесь.</p>
          </fieldset>

          <fieldset disabled={locked} className={`${card} space-y-4`}>
            <legend className="px-2 text-lg font-semibold">Заказчик и контакт для ответа</legend>
            <label className="block text-sm font-medium">ФИО заказчика<input className={input} name="customerName" autoComplete="name" required maxLength={300} /></label>
            <p className="text-xs leading-relaxed text-muted-foreground">Укажите заказчика по договору. Если платить и ехать будут разные люди, организатор сверит заявление с договором отдельно.</p>
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="text-sm font-medium">Email<input className={input} name="email" type="email" autoComplete="email" required maxLength={254} /></label>
              <label className="text-sm font-medium">Телефон<input className={input} name="phone" type="tel" autoComplete="tel" required maxLength={40} /></label>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">Организатор стремится сообщить расчёт и дальнейшие действия не позднее пяти рабочих дней; это не продлевает установленный законом срок возврата.</p>
          </fieldset>

          <fieldset key={confirmationBasis(view)} disabled={locked || !available} className={`${card} space-y-4`}>
            <legend className="px-2 text-lg font-semibold">Перед отправкой</legend>
            <label className="flex items-start gap-3 text-sm leading-relaxed"><input className="mt-1 size-4 shrink-0 accent-secondary" type="checkbox" name="policyAcknowledged" value="yes" required /><span>Я ознакомлен(а) с <a className="text-secondary underline underline-offset-4" href={view.policy.href} target="_blank" rel="noreferrer">Правилами отказа и возврата</a> (ред. {view.policy.updatedAtLabel}) и понимаю, что показанные суммы ориентировочные: законный размер возврата определяется отдельно по документально подтверждённым расходам, относящимся к моему заказу.</span></label>
          </fieldset>

          {!available && <p className="text-sm text-muted-foreground">Проверка наличия ещё не отменённых мест выполняется при открытии страницы. Если все места уже отменены или исполнены, отказ через форму недоступен.</p>}
          {status === "editing" && !locked && available && <SmartCaptcha key={captchaRevision} widget={captcha} onProof={reportProof} onRetry={retryCaptcha} />}
          <div ref={noticeRef} tabIndex={-1} role="status" className={notice || status === "unknown" || view.session.recoveryRequired ? "rounded-xl border border-border bg-accent p-5 text-sm leading-relaxed outline-secondary" : "sr-only"}>{notice}{(status === "unknown" || view.session.recoveryRequired) && <p>Сначала уточните состояние заявления у организатора. Код обращения: {view.session.clientRequestId}. Перезагрузка страницы не разрешает повторную отправку.</p>}</div>
          {!submit && <p className="text-sm text-muted-foreground">Онлайн-отправка заявления пока недоступна. Вы можете направить его на <a className="text-secondary underline underline-offset-4" href={`mailto:${view.policy.refundsEmail}`}>{view.policy.refundsEmail}</a>.</p>}
          <button type="submit" disabled={!submit || !hasProof || locked || status !== "editing" || !available || !scopeReady} className={`${action} w-full`}>
            {status === "submitting" ? "Отправляем заявление…" : status === "unknown" ? "Нужно уточнить состояние заявления" : status === "received" ? "Заявление получено" : "Отправить заявление об отказе"}<ArrowRight className="size-4" aria-hidden />
          </button>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden />Отправка заявления не возвращает деньги. Возврат — через ту же платёжную цепочку, которой был оплачен заказ, в срок, установленный законом.</p>
        </form>

        <aside aria-label="Деньги по заказу" className="order-first min-w-0 lg:sticky lg:top-24 lg:order-last">
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="bg-accent p-6"><p className="text-xs font-semibold uppercase tracking-widest text-accent-foreground">Деньги по заказу</p><p className="mt-3 text-sm text-muted-foreground">Суммы предоставлены организатором и не рассчитываются в браузере.</p></div>
            <dl className="space-y-4 p-6">
              <div><dt className="text-sm text-muted-foreground">Оплачено</dt><dd className="mt-1 font-semibold tabular-nums">{money.paidLabel}</dd></div>
              <div><dt className="text-sm text-muted-foreground">Из них предоплата</dt><dd className="mt-1 font-semibold tabular-nums">{money.depositLabel}</dd></div>
              <div><dt className="text-sm text-muted-foreground">Остаток к доплате</dt><dd className="mt-1 font-semibold tabular-nums">{money.balanceDueLabel}</dd></div>
              <div><dt className="text-sm text-muted-foreground">Подтверждённые удержанные расходы</dt><dd className="mt-1 font-semibold tabular-nums">{money.retainedExpensesLabel}</dd></div>
              <div className="border-t border-border pt-5"><dt className="text-sm font-semibold">{money.indicative ? "Ориентировочный возврат" : "Возврат к перечислению"}</dt><dd className="mt-1 text-3xl font-semibold tabular-nums">{money.indicativeRefundLabel}</dd></div>
            </dl>
            {money.indicative && <p className="flex items-start gap-2 border-t border-border p-6 text-xs leading-relaxed text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />Это предложение добровольного урегулирования, а не фиксированная неустойка и не отказ от права на возврат. Если подтверждённый законный возврат больше — организатор вернёт большую сумму.</p>}
          </div>
          <Link href="/#contacts" prefetch={false} className="mt-5 inline-block text-sm font-semibold text-secondary underline underline-offset-4">Связаться с организатором</Link>
        </aside>
      </div>
    </div>
  );
}
