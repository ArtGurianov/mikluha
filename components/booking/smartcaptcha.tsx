"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CaptchaEvent, CaptchaMount } from "@/lib/smartcaptcha-widget";

export function SmartCaptcha({ mount, onProof, onRetry }: {
  mount?: CaptchaMount;
  onProof: (token: string | null) => void;
  onRetry: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<CaptchaEvent["kind"] | "loading">(mount ? "loading" : "unavailable");
  const description = useId();
  useEffect(() => {
    if (!mount || !container.current) return;
    let live = true;
    let failed = false;
    const report = (event: CaptchaEvent) => {
      if (!live || failed) return;
      failed = event.kind === "unavailable";
      setState(event.kind);
      onProof(event.kind === "solved" ? event.token : null);
    };
    let dispose: (() => void) | undefined;
    try { dispose = mount(container.current, report); }
    catch { report({ kind: "unavailable" }); }
    return () => { live = false; dispose?.(); };
  }, [mount, onProof]);

  const text = {
    loading: "Загружаем проверку безопасности…",
    ready: "Подтвердите, что вы не робот.",
    solved: "Проверка пройдена. Можно отправить данные заявки.",
    expired: "Проверка устарела. Пройдите её ещё раз.",
    unavailable: "Не удалось загрузить проверку безопасности. Отправка пока недоступна.",
  }[state];
  return (
    <section aria-label="Проверка безопасности" className="rounded-2xl border border-border bg-muted/40 p-5">
      <h3 className="font-semibold">Проверка безопасности</h3>
      <div ref={container} aria-describedby={description} className="mt-3 min-h-24 min-w-0" aria-busy={state === "loading"} />
      <p id={description} role="status" className="mt-2 text-sm text-muted-foreground">{text}</p>
      {(state === "unavailable" || state === "expired") && (
        <button type="button" onClick={onRetry} className="mt-3 rounded-lg border border-secondary px-4 py-2 text-sm font-semibold text-secondary focus-visible:outline-2 focus-visible:outline-offset-4">
          Повторить проверку
        </button>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Яндекс SmartCaptcha обрабатывает технические данные для защиты формы. Проверка не бронирует места.
      </p>
    </section>
  );
}
