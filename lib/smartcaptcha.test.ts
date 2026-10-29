import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import SmartCaptcha, { type SmartCaptchaApi } from "../components/booking/vendor/flexperiment-smartcaptcha";
import { NativeCheckout } from "../components/booking/native-checkout";
import type { BookingOutcome, BookingPresentation } from "./native-checkout";
import { previewBookingView } from "../components/booking/checkout-preview-data";
import type { CaptchaWidgetProps } from "../components/booking/smartcaptcha";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://ui.example.invalid" });
Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, FormData: dom.window.FormData, requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), IS_REACT_ACT_ENVIRONMENT: true });

function fakeApi() {
  const events = new Map<string, () => void>();
  let solved: (token: string) => void = () => {};
  let rendered = 0, destroyed = 0, removed = 0, resets = 0;
  const api: SmartCaptchaApi = {
    render(_node, options) { assert.equal(options.hl, "ru"); solved = options.callback; rendered++; return 42; },
    subscribe(id, event, callback) { assert.equal(id, 42); events.set(event, callback); return () => { removed++; }; },
    reset(id) { assert.equal(id, 42); resets++; },
    destroy(id) { assert.equal(id, 42); destroyed++; },
  };
  return { api, events, solve: (token: string) => solved(token), counts: () => ({ rendered, destroyed, removed, resets }) };
}

async function fixture(siteKey: string) {
  const originalKey = process.env.NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY;
  process.env.NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY = siteKey;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const tokens: Array<string | null> = [];
  const onToken = (token: string | null) => tokens.push(token);
  const render = async (resetKey = 0) => { await act(async () => { root.render(createElement(SmartCaptcha, { onToken, resetKey })); }); };
  await render();
  return { host, tokens, render, stop: async () => {
    await act(async () => root.unmount()); host.remove();
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY;
    else process.env.NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY = originalKey;
    delete window.smartCaptcha;
  } };
}

test("reused Flexperiment component fails closed without a site key and does not fetch a script", async () => {
  const f = await fixture("");
  try {
    assert.match(f.host.textContent ?? "", /Не удалось загрузить проверку/);
    assert.equal(document.querySelectorAll('script[src*="smartcaptcha"]').length, 0);
    assert.ok(!f.tokens.some(Boolean));
  } finally { await f.stop(); }
});

test("reused widget expires and resets proof, ignores fatal-error/stale callbacks, and destroys its listeners", async () => {
  const fake = fakeApi();
  window.smartCaptcha = fake.api;
  const f = await fixture("synthetic-client-key");
  try {
    await act(async () => fake.solve("proof-1"));
    assert.equal(f.tokens.at(-1), "proof-1");
    await act(async () => fake.solve(""));
    assert.equal(f.tokens.at(-1), null);
    await act(async () => fake.solve("proof-1"));
    await act(async () => fake.events.get("token-expired")!());
    assert.equal(f.tokens.at(-1), null);
    await act(async () => fake.solve("proof-2"));
    await f.render(1);
    assert.equal(f.tokens.at(-1), null);
    assert.equal(fake.counts().resets, 1);
    await act(async () => fake.events.get("javascript-error")!());
    await act(async () => fake.solve("late-proof"));
    assert.equal(f.tokens.at(-1), null);
    assert.match(f.host.textContent ?? "", /Не удалось загрузить проверку/);
  } finally { await f.stop(); }
  fake.solve("after-unmount");
  assert.equal(f.tokens.at(-1), null);
  assert.deepEqual(fake.counts(), { rendered: 1, destroyed: 1, removed: 3, resets: 1 });
});

test("network errors invalidate the existing proof", async () => {
  const fake = fakeApi();
  window.smartCaptcha = fake.api;
  const f = await fixture("synthetic-client-key");
  try {
    await act(async () => fake.solve("proof"));
    await act(async () => fake.events.get("network-error")!());
    assert.equal(f.tokens.at(-1), null);
    await act(async () => fake.solve("stale-proof"));
    assert.equal(f.tokens.at(-1), null);
  } finally { await f.stop(); }
});

test("the Flexperiment loader retries a failed script and never renders after pending-load unmount", async () => {
  const first = await fixture("synthetic-client-key");
  const script = document.querySelector('script[src="https://smartcaptcha.cloud.yandex.ru/captcha.js"]')!;
  assert.ok(script);
  await act(async () => { script.dispatchEvent(new dom.window.Event("error")); });
  assert.match(first.host.textContent ?? "", /Не удалось загрузить проверку/);
  await first.stop();
  const second = await fixture("synthetic-client-key");
  const scripts = document.querySelectorAll('script[src="https://smartcaptcha.cloud.yandex.ru/captcha.js"]');
  assert.equal(scripts.length, 2);
  await second.stop();
  const fake = fakeApi();
  window.smartCaptcha = fake.api;
  await act(async () => { scripts[1].dispatchEvent(new dom.window.Event("load")); });
  assert.equal(fake.counts().rendered, 0);
  delete window.smartCaptcha;
});

function SyntheticWidget({ onToken }: CaptchaWidgetProps) {
  return createElement("button", { type: "button", onClick: () => onToken("synthetic-proof") }, "Solve synthetic captcha");
}

test("checkout retains data across rejection, requires fresh proof, prevents duplicate submits and fences UNKNOWN", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const view = previewBookingView();
  let finish!: (outcome: BookingOutcome) => void;
  let calls = 0;
  const submit = async () => { calls++; return new Promise<BookingOutcome>((resolve) => { finish = resolve; }); };
  const clickProof = async () => { await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Solve synthetic captcha")!.click()); };
  const dispatch = () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  try {
    await act(async () => root.render(createElement(NativeCheckout, { view, captcha: SyntheticWidget, submit })));
    const email = host.querySelector<HTMLInputElement>('input[name="email"]')!;
    email.value = "synthetic@example.invalid";
    await act(async () => { dispatch(); });
    assert.equal(calls, 0);
    await clickProof();
    await act(async () => host.querySelector<HTMLInputElement>('input[name="paymentChoice"]')!.click());
    await act(async () => { dispatch(); dispatch(); });
    assert.equal(calls, 1);
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    await act(async () => finish({ kind: "rejected", code: "CAPTCHA_INVALID" }));
    assert.equal(email.value, "synthetic@example.invalid");
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    await act(async () => { dispatch(); });
    assert.equal(calls, 1);
    await clickProof();
    await act(async () => { dispatch(); });
    assert.equal(calls, 2);
    await act(async () => finish({ kind: "unknown" }));
    await act(async () => { dispatch(); });
    assert.equal(calls, 2);
    assert.match(host.textContent ?? "", /Заявка могла быть создана/);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("party changes require a refreshed quote and choice, without losing tourist/contact inputs", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let sizeRequested = 0, calls = 0;
  const submit = async (): Promise<BookingOutcome> => { calls++; return { kind: "unknown" }; };
  const onPartySizeChange = (size: number) => { sizeRequested = size; };
  const render = async (view: BookingPresentation) => { await act(async () => root.render(createElement(NativeCheckout, { view, captcha: SyntheticWidget, submit, onPartySizeChange }))); };
  const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === text)!;
  const send = () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  try {
    await render(previewBookingView());
    const email = host.querySelector<HTMLInputElement>('input[name="email"]')!; email.value = "kept@example.invalid";
    const name = host.querySelector<HTMLInputElement>('input[name="p1Name"]')!; name.value = "Synthetic Adult";
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="paymentChoice"]')!.click(); button("Solve synthetic captcha").click(); });
    await act(async () => button("Добавить взрослого туриста").click());
    assert.equal(sizeRequested, 2);
    assert.match(host.textContent ?? "", /Ожидаем обновлённые цены/);
    await act(async () => { send(); }); assert.equal(calls, 0);
    await render(previewBookingView(2));
    assert.equal(email.value, "kept@example.invalid"); assert.equal(name.value, "Synthetic Adult");
    assert.match(host.textContent ?? "", /17 500 ₽/);
    assert.match(host.textContent ?? "", /10 000 ₽/);
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="paymentChoice"]')!.click(); button("Solve synthetic captcha").click(); });
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, false);
    const revised = previewBookingView(2); revised.quote.hash = "changed-hash";
    await render(revised);
    assert.equal(host.querySelector<HTMLInputElement>('input[name="paymentChoice"]')!.checked, false);
    await act(async () => { send(); }); assert.equal(calls, 0);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("payment presentation follows server options; children stay manager-assisted and additional fields follow one schema", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = async (view: BookingPresentation) => { await act(async () => root.render(createElement(NativeCheckout, { view, captcha: SyntheticWidget }))); };
  try {
    await render(previewBookingView(1, "capped"));
    assert.match(host.querySelector('input[name="paymentChoice"]')!.parentElement!.textContent ?? "", /Предоплата — 4 000 ₽/);
    assert.match(host.textContent ?? "", /дополнительная услуга/);
    assert.match(host.textContent ?? "", /Для поездки с ребёнком нужна единая заявка/);
    assert.ok(!host.textContent?.includes("ЕИС «Электронная путёвка»"));
    const fullOnly = previewBookingView(1, "full-only");
    fullOnly.touristDataSchema.fields = [{ key: "syntheticRequired", label: "Поле из синтетической схемы", type: "select", required: true, options: [{ value: "fixture", label: "Тест" }] }];
    await render(fullOnly);
    assert.equal(host.querySelectorAll('input[name="paymentChoice"]').length, 1);
    assert.match(host.querySelector('input[name="paymentChoice"]')!.parentElement!.textContent ?? "", /Полная оплата/);
    assert.equal(host.querySelector<HTMLSelectElement>('select[name="p1Extra_syntheticRequired"]')!.required, true);
    await render(previewBookingView(1, "closed"));
    assert.equal(host.querySelectorAll('input[name="paymentChoice"]').length, 0);
    assert.match(host.textContent ?? "", /Онлайн-оформление закрыто/);
    await render(previewBookingView(1, "schema-pending"));
    assert.match(host.textContent ?? "", /Состав данных для оформления уточняется/);
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
