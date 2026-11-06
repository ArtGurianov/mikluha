"use client";

import { useEffect, useState } from "react";
import type { CancellationOutcome } from "@/lib/cancellation-request";
import type { CaptchaWidgetProps } from "./smartcaptcha";
import { CancellationRequest } from "./cancellation-request";
import { previewCancellationView, type CancellationScenario } from "./cancellation-preview-data";

type PreviewAdapter = "received" | "unknown" | "not_dispatched" | Extract<CancellationOutcome, { kind: "rejected" | "refresh_required" }>["code"];

function SyntheticCaptcha({ onToken }: CaptchaWidgetProps) {
  const [state, setState] = useState("loading");
  useEffect(() => {
    const timer = setTimeout(() => setState("ready"), 700);
    const expire = () => { setState("ready"); onToken(null); };
    const fail = () => { setState("invalid"); onToken(null); };
    window.addEventListener("preview-captcha-expired", expire);
    window.addEventListener("preview-captcha-error", fail);
    return () => { clearTimeout(timer); window.removeEventListener("preview-captcha-expired", expire); window.removeEventListener("preview-captcha-error", fail); };
  }, [onToken]);
  return <div className="min-h-24">
    {state === "loading" ? <p role="status">Загружаем тестовую проверку…</p> : <button type="button" disabled={state !== "ready"} className="rounded-lg border border-border bg-card px-4 py-3 text-sm font-semibold text-secondary" onClick={() => { setState("solved"); onToken("synthetic-preview-proof"); }}>{state === "solved" ? "Тестовая проверка пройдена" : state === "invalid" ? "Тестовая проверка недействительна" : "Пройти тестовую проверку"}</button>}
  </div>;
}

/** Local lab. Real CAPTCHA is opt-in; submit is always synthetic and never calls a backend or bank. */
export function CancellationPreview() {
  const [adapter, setAdapter] = useState<PreviewAdapter>("received");
  const [scenario, setScenario] = useState<CancellationScenario>("voluntary-early");
  const [session, setSession] = useState(0);
  const [connected, setConnected] = useState(true);
  const [realCaptcha, setRealCaptcha] = useState(false);
  const [requests, setRequests] = useState(0);
  const view = previewCancellationView(scenario);

  async function submit(): Promise<CancellationOutcome> {
    setRequests((count) => count + 1);
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (adapter === "unknown") throw new Error("SYNTHETIC_LOST_ACK");
    if (adapter === "received") return { kind: "received", reference: "REF-PREVIEW-01" };
    if (adapter === "not_dispatched") return { kind: "not_dispatched" };
    if (adapter === "SCOPE_STALE" || adapter === "POLICY_CHANGED" || adapter === "ALREADY_REQUESTED") return { kind: "refresh_required", code: adapter };
    return { kind: "rejected", code: adapter };
  }

  return <>
    <section aria-label="Стенд UI отказа и возврата" className="border-y border-secondary/20 bg-secondary/5 px-4 py-5 text-sm sm:px-8">
      <div className="mx-auto max-w-5xl">
        <p className="font-semibold">Локальный UI-стенд · TOUR-32</p>
        <p className="mt-1 text-muted-foreground">Синтетический заказ. Заявления, отмены и возвраты не создаются. Вводите только вымышленные данные. Тестовая сессия сбрасывается при перезагрузке. Реальная CAPTCHA подключается только по переключателю ниже.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="grid gap-1">Состояние заказа<select className="max-w-full rounded-lg border border-border bg-card p-2" value={scenario} onChange={(event) => { setScenario(event.target.value as CancellationScenario); setSession((n) => n + 1); }}>
            <option value="voluntary-early">Добровольный отказ · заранее</option>
            <option value="voluntary-late">Добровольный отказ · близко к выезду</option>
            <option value="whole-only">Только отказ от всей брони</option>
            <option value="nothing-cancellable">Нечего отменять</option>
            <option value="final-amount">Итоговый расчёт возврата</option>
          </select></label>
          <label className="grid gap-1">Ответ адаптера<select className="max-w-full rounded-lg border border-border bg-card p-2" value={adapter} onChange={(event) => setAdapter(event.target.value as PreviewAdapter)}>
            <option value="received">Заявление получено</option><option value="CAPTCHA_INVALID">CAPTCHA не принята</option><option value="CAPTCHA_UNAVAILABLE">CAPTCHA недоступна</option><option value="RATE_LIMITED">Слишком много попыток</option><option value="ORDER_NOT_FOUND">Заказ не найден</option><option value="NOTHING_CANCELLABLE">Нечего отменять</option><option value="FORM_INVALID">Ошибка данных</option><option value="unknown">Ответ потерян / UNKNOWN</option>
            <option value="SCOPE_STALE">Состав изменился</option><option value="POLICY_CHANGED">Правила изменились</option><option value="ALREADY_REQUESTED">Отказ уже заявлен</option><option value="not_dispatched">Запрос точно не отправлялся</option>
          </select></label>
          <button type="button" disabled={realCaptcha} className="rounded-lg border border-border bg-card p-2" onClick={() => window.dispatchEvent(new Event("preview-captcha-expired"))}>Истечение CAPTCHA</button>
          <button type="button" disabled={realCaptcha} className="rounded-lg border border-border bg-card p-2" onClick={() => window.dispatchEvent(new Event("preview-captcha-error"))}>Ошибка CAPTCHA</button>
          <button type="button" className="rounded-lg border border-border bg-card p-2" onClick={() => { setSession((n) => n + 1); setRequests(0); }}>Новая сессия</button>
          <label className="flex items-center gap-2 p-2"><input type="checkbox" checked={connected} onChange={(event) => { setConnected(event.target.checked); setSession((n) => n + 1); }} />Тестовый адаптер подключён</label>
          <label className="flex items-center gap-2 p-2"><input type="checkbox" checked={realCaptcha} onChange={(event) => { setRealCaptcha(event.target.checked); setSession((n) => n + 1); }} />Реальная CAPTCHA Flexperiment</label>
        </div>
        <p role="status" className="mt-3 text-xs text-muted-foreground">Тестовых отправок: {requests}. Сетевых запросов к Commerce, банку и Refref: 0.</p>
      </div>
    </section>
    <CancellationRequest key={session} view={view} captcha={realCaptcha ? undefined : SyntheticCaptcha} submit={connected ? submit : undefined} />
  </>;
}
