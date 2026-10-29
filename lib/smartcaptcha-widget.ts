export type CaptchaEvent =
  | { kind: "ready" }
  | { kind: "solved"; token: string }
  | { kind: "expired" | "unavailable" };

export type CaptchaMount = (container: HTMLElement, report: (event: CaptchaEvent) => void) => () => void;

export interface SmartCaptchaApi {
  render(container: HTMLElement, options: { sitekey: string; hl: "ru"; callback: (token: string) => void }): number | string;
  subscribe(id: number | string, event: "token-expired" | "network-error" | "javascript-error", callback: () => void): () => void;
  destroy(id: number | string): void;
}

declare global { interface Window { smartCaptcha?: SmartCaptchaApi } }

let pending: Promise<SmartCaptchaApi> | undefined;

/** Only called while a protected form is mounted. Never sends form/identity data to the widget. */
export function loadSmartCaptcha(): Promise<SmartCaptchaApi> {
  if (window.smartCaptcha) return Promise.resolve(window.smartCaptcha);
  if (pending) return pending;
  pending = new Promise<SmartCaptchaApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://smartcaptcha.cloud.yandex.ru/captcha.js?render=onload";
    script.async = true;
    const timer = window.setTimeout(() => finish(), 12000);
    const finish = (api?: SmartCaptchaApi) => {
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (api) resolve(api);
      else { script.remove(); reject(new Error("CAPTCHA_UNAVAILABLE")); }
    };
    script.onload = () => finish(window.smartCaptcha);
    script.onerror = () => finish();
    document.head.append(script);
  }).catch((error: unknown) => { pending = undefined; throw error; });
  return pending;
}

/** Token is an unverified one-use proof. Verification/replay protection belong to the server. */
export function smartCaptchaMount(siteKey: string, load = loadSmartCaptcha): CaptchaMount {
  return (container, report) => {
    let disposed = false;
    let disposeWidget = () => {};
    if (!siteKey.trim()) { report({ kind: "unavailable" }); return disposeWidget; }
    void load().then((api) => {
      if (disposed) return;
      let failed = false;
      const publish = (event: CaptchaEvent) => { if (!disposed && !failed) report(event); };
      const fail = () => { publish({ kind: "unavailable" }); failed = true; };
      publish({ kind: "ready" });
      const id = api.render(container, {
        sitekey: siteKey, hl: "ru",
        callback: (token) => publish(token ? { kind: "solved", token } : { kind: "expired" }),
      });
      const unsubscribe: Array<() => void> = [];
      let destroyed = false;
      disposeWidget = () => {
        if (destroyed) return;
        destroyed = true;
        unsubscribe.forEach((remove) => remove());
        api.destroy(id);
      };
      unsubscribe.push(api.subscribe(id, "token-expired", () => publish({ kind: "expired" })));
      unsubscribe.push(api.subscribe(id, "network-error", fail));
      unsubscribe.push(api.subscribe(id, "javascript-error", fail));
    }).catch(() => {
      disposeWidget();
      if (!disposed) report({ kind: "unavailable" });
    });
    return () => { disposed = true; disposeWidget(); };
  };
}
