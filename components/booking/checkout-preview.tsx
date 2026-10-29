"use client";

import { useEffect, useState } from "react";
import type { BookingOutcome, BookingPresentation } from "@/lib/native-checkout";
import type { CaptchaWidgetProps } from "./smartcaptcha";
import { NativeCheckout } from "./native-checkout";

const view: BookingPresentation = {
  departureId: "preview-synthetic-departure", title: "Выходные в горах Алтая",
  dateLabel: "14–16 ноября · пример выезда", departureLabel: "Отправление из Новосибирска",
  priceLabel: "18 000 ₽", paymentLabel: "Первый взнос — 6 000 ₽",
  paymentDetail: "Остаток — по условиям Заявки. Точные суммы и сроки вы увидите перед оплатой.",
  maxParticipants: 4,
  terms: { ref: "PREVIEW-ONLY", hash: "PREVIEW-ONLY" }, pdConsent: { ref: "PREVIEW-ONLY", hash: "PREVIEW-ONLY" },
};

function SyntheticCaptcha({ onToken }: CaptchaWidgetProps) {
  const [state, setState] = useState("loading");
  useEffect(() => {
    const timer = setTimeout(() => setState("ready"), 700);
    const invalidate = () => { setState("invalid"); onToken(null); };
    window.addEventListener("preview-captcha-invalid", invalidate);
    return () => { clearTimeout(timer); window.removeEventListener("preview-captcha-invalid", invalidate); };
  }, [onToken]);
  return <div className="min-h-24">
    {state === "loading" ? <p role="status">Загружаем тестовую проверку…</p> : <button type="button" disabled={state !== "ready"} className="rounded-lg border border-border bg-card px-4 py-3 text-sm font-semibold text-secondary" onClick={() => { setState("solved"); onToken("synthetic-preview-proof"); }}>{state === "solved" ? "Тестовая проверка пройдена" : state === "invalid" ? "Тестовая проверка недействительна" : "Пройти тестовую проверку"}</button>}
  </div>;
}

/** Local lab. Real CAPTCHA is opt-in; submit is always synthetic and never calls a backend. */
export function CheckoutPreview() {
  const [scenario, setScenario] = useState<"review" | "CAPTCHA_INVALID" | "CAPTCHA_UNAVAILABLE" | "RATE_LIMITED" | "NOT_ENOUGH_SEATS" | "SALES_CLOSED" | "FORM_INVALID" | "unknown">("CAPTCHA_INVALID");
  const [session, setSession] = useState(0);
  const [connected, setConnected] = useState(true);
  const [realCaptcha, setRealCaptcha] = useState(false);
  const [requests, setRequests] = useState(0);

  async function submit(): Promise<BookingOutcome> {
    setRequests((count) => count + 1);
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (scenario === "unknown") throw new Error("SYNTHETIC_LOST_ACK");
    if (scenario === "review") return { kind: "review", reference: "PREVIEW-01" };
    return { kind: "rejected", code: scenario };
  }

  return <>
    <section aria-label="Стенд checkout UI" className="border-y border-secondary/20 bg-secondary/5 px-4 py-5 text-sm sm:px-8">
      <div className="mx-auto max-w-6xl">
        <p className="font-semibold">Локальный UI-стенд · TOUR-28 / TOUR-49</p>
        <p className="mt-1 text-muted-foreground">Синтетический выезд. Заявки, места и платежи не создаются. Вводите только вымышленные данные. Реальная CAPTCHA подключается только по переключателю ниже.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="grid gap-1">Ответ адаптера<select className="max-w-full rounded-lg border border-border bg-card p-2" value={scenario} onChange={(event) => setScenario(event.target.value as typeof scenario)}>
            <option value="CAPTCHA_INVALID">CAPTCHA не принята</option><option value="CAPTCHA_UNAVAILABLE">CAPTCHA недоступна</option><option value="RATE_LIMITED">Слишком много попыток</option><option value="NOT_ENOUGH_SEATS">Нет мест</option><option value="SALES_CLOSED">Продажи закрыты</option><option value="FORM_INVALID">Ошибка данных</option><option value="unknown">Ответ потерян / UNKNOWN</option><option value="review">Заявка получена</option>
          </select></label>
          <button type="button" disabled={realCaptcha} className="rounded-lg border border-border bg-card p-2" onClick={() => window.dispatchEvent(new Event("preview-captcha-invalid"))}>Истечение CAPTCHA</button>
          <button type="button" disabled={realCaptcha} className="rounded-lg border border-border bg-card p-2" onClick={() => window.dispatchEvent(new Event("preview-captcha-invalid"))}>Ошибка CAPTCHA</button>
          <button type="button" className="rounded-lg border border-border bg-card p-2" onClick={() => { setSession((n) => n + 1); setRequests(0); }}>Новая сессия</button>
          <label className="flex items-center gap-2 p-2"><input type="checkbox" checked={connected} onChange={(event) => { setConnected(event.target.checked); setSession((n) => n + 1); }} />Тестовый адаптер подключён</label>
          <label className="flex items-center gap-2 p-2"><input type="checkbox" checked={realCaptcha} onChange={(event) => { setRealCaptcha(event.target.checked); setSession((n) => n + 1); }} />Реальная CAPTCHA Flexperiment</label>
        </div>
        <p role="status" className="mt-3 text-xs text-muted-foreground">Тестовых отправок: {requests}. Сетевых запросов к Commerce, банку и Refref: 0.</p>
      </div>
    </section>
    <NativeCheckout key={session} view={view} captcha={realCaptcha ? undefined : SyntheticCaptcha} submit={connected ? submit : undefined} />
  </>;
}
