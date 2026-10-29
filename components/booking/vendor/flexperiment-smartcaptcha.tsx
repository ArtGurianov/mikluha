"use client";

import { useEffect, useRef, useState } from "react";

type WidgetId = string | number;
export type SmartCaptchaApi = {
  render(container: HTMLElement, options: { sitekey: string; hl: "ru"; callback: (token: string) => void }): WidgetId;
  reset(widgetId: WidgetId): void;
  destroy(widgetId: WidgetId): void;
  subscribe(widgetId: WidgetId, event: "network-error" | "javascript-error" | "token-expired", callback: () => void): () => void;
};

declare global {
  interface Window { smartCaptcha?: SmartCaptchaApi }
}

let smartCaptchaScript: Promise<SmartCaptchaApi> | null = null;
export const SMARTCAPTCHA_LOAD_TIMEOUT_MS = 10_000;

const loadSmartCaptcha = () => {
  if (window.smartCaptcha) return Promise.resolve(window.smartCaptcha);
  if (smartCaptchaScript) return smartCaptchaScript;
  smartCaptchaScript = new Promise<SmartCaptchaApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://smartcaptcha.cloud.yandex.ru/captcha.js";
    script.async = true;
    let settled = false;
    const finish = (api?: SmartCaptchaApi) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (api) resolve(api);
      else { script.remove(); reject(new Error("SMARTCAPTCHA_UNAVAILABLE")); }
    };
    const timer = setTimeout(() => finish(), SMARTCAPTCHA_LOAD_TIMEOUT_MS);
    script.onload = () => finish(window.smartCaptcha);
    script.onerror = () => finish();
    document.head.append(script);
  }).finally(() => {
    smartCaptchaScript = null;
  });
  return smartCaptchaScript;
};

type Props = {
  onToken: (token: string | null) => void;
  resetKey: number;
};

/**
 * SmartCaptcha is a security dependency, not an analytics tag. It loads only
 * while a protected form is visible and never observes analytics consent.
 */
export default function SmartCaptcha({ onToken, resetKey }: Props) {
  const siteKey = process.env.NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY;
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<WidgetId | null>(null);
  const failed = useRef(false);
  const [state, setState] = useState<"loading" | "ready" | "solved" | "error">(() => siteKey ? "loading" : "error");

  useEffect(() => {
    let disposed = false;
    failed.current = false;
    let unsubscribe: (() => void)[] = [];
    if (!siteKey) return;
    void loadSmartCaptcha().then((api) => {
      if (disposed || !container.current) return;
      const id = api.render(container.current, {
        sitekey: siteKey,
        hl: "ru",
        callback: (token) => {
          if (disposed || failed.current) return;
          if (!token) { setState("ready"); onToken(null); return; }
          setState("solved");
          onToken(token);
        },
      });
      widgetId.current = id;
      const invalidate = () => {
        if (disposed || failed.current) return;
        setState("ready");
        onToken(null);
      };
      unsubscribe = [
        api.subscribe(id, "token-expired", invalidate),
        api.subscribe(id, "network-error", () => { if (disposed) return; failed.current = true; setState("error"); onToken(null); }),
        api.subscribe(id, "javascript-error", () => { if (disposed) return; failed.current = true; setState("error"); onToken(null); }),
      ];
      setState("ready");
    }).catch(() => {
      if (!disposed) { setState("error"); onToken(null); }
    });
    return () => {
      disposed = true;
      unsubscribe.forEach((remove) => remove());
      if (widgetId.current !== null && window.smartCaptcha) window.smartCaptcha.destroy(widgetId.current);
      widgetId.current = null;
    };
  }, [onToken, siteKey]);

  useEffect(() => {
    if (widgetId.current === null || !window.smartCaptcha) return;
    window.smartCaptcha.reset(widgetId.current);
    failed.current = false;
    setState("ready");
    onToken(null);
  }, [onToken, resetKey]);

  return <div>
    <div ref={container} role="group" className="min-h-[100px]" aria-label="Проверка безопасности" />
    {state === "loading" && <p className="text-xs text-muted-foreground" role="status">Загружаем проверку…</p>}
    {state === "error" && <p className="text-xs text-muted-foreground" role="status">Не удалось загрузить проверку. Попробуйте повторить проверку.</p>}
  </div>;
}
