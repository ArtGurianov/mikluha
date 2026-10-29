"use client";

import { useCallback, useState } from "react";
import type { ComponentProps, ComponentType } from "react";
import FlexperimentSmartCaptcha from "./vendor/flexperiment-smartcaptcha";

export type CaptchaWidgetProps = ComponentProps<typeof FlexperimentSmartCaptcha>;
export type CaptchaWidget = ComponentType<CaptchaWidgetProps>;

/** Checkout presentation only. SDK loading and widget lifecycle are reused from Flexperiment. */
export function SmartCaptcha({ widget: Widget = FlexperimentSmartCaptcha, onProof, onRetry }: {
  widget?: CaptchaWidget;
  onProof: (token: string | null) => void;
  onRetry: () => void;
}) {
  const [solved, setSolved] = useState(false);
  const onToken = useCallback((token: string | null) => {
    setSolved(Boolean(token));
    onProof(token);
  }, [onProof]);
  return (
    <section aria-label="Проверка безопасности" className="rounded-2xl border border-border bg-muted/40 p-5">
      <h3 className="mb-3 font-semibold">Проверка безопасности</h3>
      <Widget onToken={onToken} resetKey={0} />
      <p role="status" className="mt-2 text-sm text-muted-foreground">
        {solved ? "Проверка пройдена. Можно отправить данные заявки." : "Подтвердите, что вы не робот. Если проверка устарела или недоступна, повторите её."}
      </p>
      <button type="button" onClick={onRetry} className="mt-3 rounded-lg border border-secondary px-4 py-2 text-sm font-semibold text-secondary focus-visible:outline-2 focus-visible:outline-offset-4">Повторить проверку</button>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Яндекс SmartCaptcha обрабатывает технические данные для защиты формы. Проверка не бронирует места.</p>
    </section>
  );
}
