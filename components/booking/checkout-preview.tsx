"use client";

import { useMemo, useRef, useState } from "react";
import type { BookingOutcome, BookingPresentation } from "@/lib/native-checkout";
import type { CaptchaEvent, CaptchaMount } from "@/lib/smartcaptcha-widget";
import { NativeCheckout } from "./native-checkout";

const view: BookingPresentation = {
  departureId: "preview-synthetic-departure", title: "Выходные в горах Алтая",
  dateLabel: "14–16 ноября · пример выезда", departureLabel: "Отправление из Новосибирска",
  priceLabel: "18 000 ₽", paymentLabel: "Первый взнос — 6 000 ₽",
  paymentDetail: "Остаток — по условиям Заявки. Точные суммы и сроки вы увидите перед оплатой.",
  maxParticipants: 4,
  terms: { ref: "PREVIEW-ONLY", hash: "PREVIEW-ONLY" }, pdConsent: { ref: "PREVIEW-ONLY", hash: "PREVIEW-ONLY" },
};

/** Local UI lab. The page imports this only in development; no real adapter or provider traffic. */
export function CheckoutPreview() {
  const [scenario, setScenario] = useState<"review" | "CAPTCHA_INVALID" | "CAPTCHA_UNAVAILABLE" | "RATE_LIMITED" | "NOT_ENOUGH_SEATS" | "SALES_CLOSED" | "FORM_INVALID" | "unknown">("CAPTCHA_INVALID");
  const [session, setSession] = useState(0);
  const [connected, setConnected] = useState(true);
  const [requests, setRequests] = useState(0);
  const emit = useRef<((event: CaptchaEvent) => void) | null>(null);
  const mount = useMemo<CaptchaMount>(() => (container, report) => {
    emit.current = report;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Пройти тестовую проверку";
    button.className = "rounded-lg border border-border bg-card px-4 py-3 text-sm font-semibold text-secondary";
    button.addEventListener("click", () => {
      report({ kind: "solved", token: "synthetic-preview-proof" });
      button.disabled = true;
      button.textContent = "Тестовая проверка пройдена";
    });
    const timer = setTimeout(() => { container.append(button); report({ kind: "ready" }); }, 700);
    return () => { clearTimeout(timer); button.remove(); emit.current = null; };
  }, []);

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
        <p className="mt-1 text-muted-foreground">Синтетический выезд и CAPTCHA. Заявки, места и платежи не создаются. Вводите только вымышленные данные.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="grid gap-1">Ответ адаптера<select className="max-w-full rounded-lg border border-border bg-card p-2" value={scenario} onChange={(event) => setScenario(event.target.value as typeof scenario)}>
            <option value="CAPTCHA_INVALID">CAPTCHA не принята</option><option value="CAPTCHA_UNAVAILABLE">CAPTCHA недоступна</option><option value="RATE_LIMITED">Слишком много попыток</option><option value="NOT_ENOUGH_SEATS">Нет мест</option><option value="SALES_CLOSED">Продажи закрыты</option><option value="FORM_INVALID">Ошибка данных</option><option value="unknown">Ответ потерян / UNKNOWN</option><option value="review">Заявка получена</option>
          </select></label>
          <button type="button" className="rounded-lg border border-border bg-card p-2" onClick={() => emit.current?.({ kind: "expired" })}>Истечение CAPTCHA</button>
          <button type="button" className="rounded-lg border border-border bg-card p-2" onClick={() => emit.current?.({ kind: "unavailable" })}>Ошибка CAPTCHA</button>
          <button type="button" className="rounded-lg border border-border bg-card p-2" onClick={() => { setSession((n) => n + 1); setRequests(0); }}>Новая сессия</button>
          <label className="flex items-center gap-2 p-2"><input type="checkbox" checked={connected} onChange={(event) => { setConnected(event.target.checked); setSession((n) => n + 1); }} />Тестовый адаптер подключён</label>
        </div>
        <p role="status" className="mt-3 text-xs text-muted-foreground">Тестовых отправок: {requests}. Сетевых запросов к Commerce, банку и Refref: 0.</p>
      </div>
    </section>
    <NativeCheckout key={session} view={view} captcha={connected ? mount : undefined} submit={connected ? submit : undefined} />
  </>;
}
