import { dom } from "./test-support/dom-setup";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import SmartCaptcha, { SMARTCAPTCHA_LOAD_TIMEOUT_MS, type SmartCaptchaApi } from "../components/booking/vendor/flexperiment-smartcaptcha";
import { NativeCheckout } from "../components/booking/native-checkout";
import type { BookingOutcome, BookingPresentation, QuoteRefreshRequest } from "./native-checkout";
import { previewBookingView } from "../components/booking/checkout-preview-data";
import type { CaptchaWidgetProps } from "../components/booking/smartcaptcha";

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
  assert.equal(scripts.length, 1);
  await second.stop();
  const fake = fakeApi();
  window.smartCaptcha = fake.api;
  await act(async () => { scripts[0].dispatchEvent(new dom.window.Event("load")); });
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
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="adultsOnly"]')!.click(); host.querySelector<HTMLInputElement>('input[name="pdConsent"]')!.click(); });
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
  let calls = 0;
  const submit = async (): Promise<BookingOutcome> => { calls++; return { kind: "unknown" }; };
  const refreshQuote = async (request: QuoteRefreshRequest) => { const updated = previewBookingView(request.participantCount); updated.quote.inputRevision = request.inputRevision; return updated; };
  const render = async (view: BookingPresentation) => { await act(async () => root.render(createElement(NativeCheckout, { view, captcha: SyntheticWidget, submit, refreshQuote }))); };
  const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === text)!;
  const send = () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  try {
    await render(previewBookingView());
    const email = host.querySelector<HTMLInputElement>('input[name="email"]')!; email.value = "kept@example.invalid";
    const name = host.querySelector<HTMLInputElement>('input[name="p1Name"]')!; name.value = "Synthetic Adult";
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="paymentChoice"]')!.click(); button("Solve synthetic captcha").click(); });
    await act(async () => button("Добавить взрослого туриста").click());
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    assert.match(host.textContent ?? "", /Ожидаем обновлённые цены/);
    await act(async () => { send(); }); assert.equal(calls, 0);
    await act(async () => button("Обновить условия").click());
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

test("a script with no browser events times out; retry creates a fresh script and ignores late load", async (t) => {
  document.querySelectorAll('script[src*="smartcaptcha"]').forEach((script) => script.remove());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = await fixture("synthetic-client-key");
  const oldScript = document.querySelector<HTMLScriptElement>('script[src*="smartcaptcha"]')!;
  const lateLoad = oldScript.onload!;
  await act(async () => t.mock.timers.tick(SMARTCAPTCHA_LOAD_TIMEOUT_MS));
  assert.match(first.host.textContent ?? "", /Не удалось загрузить проверку/);
  assert.equal(oldScript.isConnected, false);
  await first.stop();
  const second = await fixture("synthetic-client-key");
  const freshScript = document.querySelector<HTMLScriptElement>('script[src*="smartcaptcha"]')!;
  assert.ok(freshScript && freshScript !== oldScript);
  const fake = fakeApi(); window.smartCaptcha = fake.api;
  try {
    await act(async () => { lateLoad.call(oldScript, new dom.window.Event("load")); });
    assert.equal(fake.counts().rendered, 0);
    await act(async () => { freshScript.dispatchEvent(new dom.window.Event("load")); });
    assert.equal(fake.counts().rendered, 1);
    await act(async () => fake.solve("fresh-proof"));
    assert.equal(second.tokens.at(-1), "fresh-proof");
  } finally { await second.stop(); freshScript.remove(); t.mock.timers.reset(); }
});

function checkoutFixture() {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const click = async (text: string) => { await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === text)!.click()); };
  const consent = async () => { await act(async () => {
    for (const name of ["adultsOnly", "pdConsent"]) { const checkbox = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; if (!checkbox.checked) checkbox.click(); }
  }); };
  const choose = async () => { await act(async () => host.querySelector<HTMLInputElement>('input[name="paymentChoice"]')!.click()); };
  const send = async () => { await act(async () => { host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); }); };
  return { host, root, click, consent, choose, send, stop: async () => { await act(async () => root.unmount()); host.remove(); } };
}

async function typeText(node: HTMLInputElement, text: string, blur = true) {
  await act(async () => node.focus());
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  let value = "";
  for (const character of text) {
    value += character;
    await act(async () => {
      setValue.call(node, value);
      node.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, data: character, inputType: "insertText" }));
    });
  }
  if (blur) await act(async () => node.blur());
}

test("DOM setup precedes React DOM: real input events reach React onChange on every typed character", async () => {
  const f = checkoutFixture(); const values: string[] = [];
  try {
    await act(async () => f.root.render(createElement("input", { onChange: (event) => values.push(event.currentTarget.value) })));
    await typeText(f.host.querySelector("input")!, "Тест");
    assert.deepEqual(values, ["Т", "Те", "Тес", "Тест"]);
  } finally { await f.stop(); }
});

test("typing/correcting ordinary name and document data preserves quote, payment, consents and CAPTCHA without refresh", async () => {
  const f = checkoutFixture(); let quoteCalls = 0;
  const submit = async (): Promise<BookingOutcome> => ({ kind: "unknown" });
  try {
    await act(async () => f.root.render(createElement(NativeCheckout, { view: previewBookingView(), captcha: SyntheticWidget, submit,
      refreshQuote: async () => { quoteCalls++; return previewBookingView(); } })));
    await f.choose(); await f.consent(); await f.click("Solve synthetic captcha");
    for (const [name, text] of [["p1Name", "Тестовый Турист"], ["p1DocNumber", "000001"]]) {
      await typeText(f.host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!, text, false);
      assert.match(f.host.textContent ?? "", /Итого за заявку/);
      assert.equal(f.host.querySelectorAll('input[name="paymentChoice"]:checked').length, 1);
      assert.equal(f.host.querySelector<HTMLInputElement>('input[name="pdConsent"]')!.checked, true);
      assert.equal(f.host.querySelector<HTMLInputElement>('input[name="adultsOnly"]')!.checked, true);
      assert.equal(f.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, false);
      await act(async () => f.host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.blur());
    }
    const type = f.host.querySelector<HTMLSelectElement>('select[name="p1DocType"]')!;
    await act(async () => { type.value = "FOREIGN_DOCUMENT"; type.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(f.host.querySelectorAll('input[name="paymentChoice"]:checked').length, 1);
    assert.equal(f.host.querySelector<HTMLInputElement>('input[name="pdConsent"]')!.checked, true);
    assert.equal(quoteCalls, 0); assert.match(f.host.textContent ?? "", /Проверка пройдена/);
    assert.ok(!f.host.textContent?.includes("Обновить условия"));
  } finally { await f.stop(); }
});

test("qualified pricing text commits on blur, preserves legal consent, and refresh sends a minimal DTO", async () => {
  const f = checkoutFixture(); const view = previewBookingView(); const requests: QuoteRefreshRequest[] = [];
  view.touristDataSchema.fields = [{ key: "band", label: "Synthetic pricing category", required: false, type: "text", priceAffecting: true }];
  const refreshQuote = async (request: QuoteRefreshRequest) => { requests.push(request); const updated = structuredClone(view); updated.quote.inputRevision = request.inputRevision; return updated; };
  try {
    await act(async () => f.root.render(createElement(NativeCheckout, { view, captcha: SyntheticWidget, refreshQuote,
      submit: async (): Promise<BookingOutcome> => ({ kind: "unknown" }) })));
    await f.choose(); await f.consent(); await f.click("Solve synthetic captcha");
    await typeText(f.host.querySelector<HTMLInputElement>('input[name="p1Name"]')!, "Synthetic Name");
    await typeText(f.host.querySelector<HTMLInputElement>('input[name="p1DocNumber"]')!, "000000");
    const band = f.host.querySelector<HTMLInputElement>('input[name="p1Extra_band"]')!;
    await typeText(band, "standard", false);
    assert.match(f.host.textContent ?? "", /Итого за заявку/);
    assert.equal(f.host.querySelectorAll('input[name="paymentChoice"]:checked').length, 1);
    assert.equal(f.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    await act(async () => band.blur());
    assert.match(f.host.textContent ?? "", /Ожидаем обновлённые цены/);
    assert.equal(f.host.querySelectorAll('input[name="paymentChoice"]:checked').length, 0);
    assert.equal(f.host.querySelector<HTMLInputElement>('input[name="pdConsent"]')!.checked, true);
    assert.equal(f.host.querySelector<HTMLInputElement>('input[name="adultsOnly"]')!.checked, true);
    await f.click("Обновить условия");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].pricingInputs, [{ additionalDetails: { band: "standard" } }]);
    assert.equal(requests[0].participantCount, 1);
    assert.ok(!JSON.stringify(requests[0]).includes("Synthetic Name"));
    assert.ok(!JSON.stringify(requests[0]).includes("000000"));
    assert.equal(f.host.querySelector<HTMLInputElement>('input[name="pdConsent"]')!.checked, true);
    await f.choose();
    await act(async () => band.focus()); await act(async () => band.blur());
    assert.equal(f.host.querySelectorAll('input[name="paymentChoice"]:checked').length, 1);
  } finally { await f.stop(); }
});

test("a pricing edit cancels an old quote before blur; only a fresh correlated refresh can restore it", async () => {
  const f = checkoutFixture(); const view = previewBookingView();
  view.touristDataSchema.fields = [{ key: "band", label: "Synthetic category", type: "text", required: false, priceAffecting: true }];
  const pending: Array<{ request: QuoteRefreshRequest; resolve: (view: BookingPresentation) => void }> = [];
  const refreshQuote = (request: QuoteRefreshRequest) => new Promise<BookingPresentation>((resolve) => pending.push({ request, resolve }));
  try {
    await act(async () => f.root.render(createElement(NativeCheckout, { view, refreshQuote, captcha: SyntheticWidget })));
    await f.click("Добавить взрослого туриста"); await f.click("Обновить условия");
    const band = f.host.querySelector<HTMLInputElement>('input[name="p1Extra_band"]')!;
    await typeText(band, "changed", false);
    const old = structuredClone(view); old.quote = previewBookingView(2).quote; old.quote.inputRevision = pending[0].request.inputRevision;
    await act(async () => pending[0].resolve(old));
    assert.ok(!f.host.querySelector("aside")!.textContent?.includes("Итого за заявку"));
    await act(async () => band.blur()); await f.click("Обновить условия");
    assert.equal(pending.length, 2); assert.notEqual(pending[1].request.inputRevision, pending[0].request.inputRevision);
    const fresh = structuredClone(old); fresh.quote.inputRevision = pending[1].request.inputRevision;
    await act(async () => pending[1].resolve(fresh));
    assert.match(f.host.querySelector("aside")!.textContent ?? "", /35 500 ₽/);
    assert.equal(pending[1].request.pricingInputs?.[0].additionalDetails?.band, "changed");
  } finally { await f.stop(); }
});

test("reverting a pricing field before blur preserves the quote and payment choice", async () => {
  const f = checkoutFixture(); const view = previewBookingView();
  view.touristDataSchema.fields = [{ key: "band", label: "Synthetic category", type: "text", required: false, priceAffecting: true }];
  try {
    await act(async () => f.root.render(createElement(NativeCheckout, { view, captcha: SyntheticWidget })));
    await f.choose(); const band = f.host.querySelector<HTMLInputElement>('input[name="p1Extra_band"]')!;
    await typeText(band, "x", false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(band, "");
      band.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })); band.blur();
    });
    assert.match(f.host.querySelector("aside")!.textContent ?? "", /Итого за заявку/);
    assert.equal(f.host.querySelectorAll('input[name="paymentChoice"]:checked').length, 1);
  } finally { await f.stop(); }
});

test("party/schema changes preserve PD consent; new document versions reset it", async () => {
  const f = checkoutFixture(); const view = previewBookingView();
  const render = async (current: BookingPresentation) => { await act(async () => f.root.render(createElement(NativeCheckout, { view: current, captcha: SyntheticWidget }))); };
  try {
    await render(view); await f.consent(); await f.click("Добавить взрослого туриста");
    assert.equal(f.host.querySelector<HTMLInputElement>('input[name="pdConsent"]')!.checked, true);
    assert.equal(f.host.querySelector<HTMLInputElement>('input[name="adultsOnly"]')!.checked, false);
    const schemaChanged = structuredClone(view); schemaChanged.touristDataSchema.hash = "new-schema";
    await render(schemaChanged);
    assert.equal(f.host.querySelector<HTMLInputElement>('input[name="pdConsent"]')!.checked, true);
    const legalChanged = structuredClone(schemaChanged); legalChanged.pdConsent.hash = "new-document";
    await render(legalChanged);
    assert.equal(f.host.querySelector<HTMLInputElement>('input[name="pdConsent"]')!.checked, false);
  } finally { await f.stop(); }
});

test("quote A → B → A never resurrects a payment choice and preserves contact fields", async () => {
  const f = checkoutFixture(); const a = previewBookingView(), b = previewBookingView(1, "full-only");
  const render = async (view: BookingPresentation) => { await act(async () => f.root.render(createElement(NativeCheckout, { view, captcha: SyntheticWidget }))); };
  try {
    await render(a); await f.choose();
    const email = f.host.querySelector<HTMLInputElement>('input[name="email"]')!; email.value = "kept@example.invalid";
    await render(b); await render(a);
    assert.equal(f.host.querySelectorAll('input[name="paymentChoice"]:checked').length, 0);
    assert.equal(email.value, "kept@example.invalid");
  } finally { await f.stop(); }
});

for (const code of ["QUOTE_STALE", "TERMS_CHANGED", "PAYMENT_OPTIONS_CHANGED"] as const) {
  test(`${code} requires an explicit read-only refresh, new payment choice and consents, without auto-submit`, async () => {
    const f = checkoutFixture(); const view = previewBookingView(); let calls = 0, quoteCalls = 0;
    const submit = async (): Promise<BookingOutcome> => { calls++; return { kind: "refresh_required", code }; };
    const refreshQuote = async (request: QuoteRefreshRequest) => {
      quoteCalls++; const updated = previewBookingView(); updated.quote.inputRevision = request.inputRevision;
      updated.quote.hash = "fresh"; updated.terms.hash = "new-terms"; return updated;
    };
    try {
      await act(async () => f.root.render(createElement(NativeCheckout, { view, submit, refreshQuote, captcha: SyntheticWidget })));
      await f.consent(); await f.choose(); await f.click("Solve synthetic captcha"); await f.send();
      assert.equal(calls, 1); assert.equal(quoteCalls, 0);
      await f.send(); assert.equal(calls, 1);
      await f.click("Обновить условия");
      assert.equal(quoteCalls, 1); assert.equal(calls, 1);
      assert.equal(f.host.querySelectorAll('input[name="paymentChoice"]:checked').length, 0);
      assert.equal(f.host.querySelector<HTMLInputElement>('input[name="pdConsent"]')!.checked, false);
      await f.click("Solve synthetic captcha"); await f.choose(); await f.send(); assert.equal(calls, 1);
      await f.consent(); await f.send(); assert.equal(calls, 2);
    } finally { await f.stop(); }
  });
}

test("out-of-order quotes for 1 → 2 → 1 cannot restore old conditions; document corrections keep the quote and proof", async () => {
  const f = checkoutFixture();
  const pending: Array<{ request: QuoteRefreshRequest; resolve: (view: BookingPresentation) => void }> = [];
  const refreshQuote = (request: QuoteRefreshRequest) => new Promise<BookingPresentation>((resolve) => pending.push({ request, resolve }));
  try {
    await act(async () => f.root.render(createElement(NativeCheckout, { view: previewBookingView(), refreshQuote, captcha: SyntheticWidget })));
    await f.click("Solve synthetic captcha");
    await f.click("Добавить взрослого туриста"); await f.click("Обновить условия");
    await f.click("Убрать туриста 2"); await f.click("Обновить условия");
    assert.equal(pending.length, 2);
    const fresh = previewBookingView(); fresh.quote.inputRevision = pending[1].request.inputRevision;
    await act(async () => pending[1].resolve(fresh));
    const old = previewBookingView(2); old.quote.inputRevision = pending[0].request.inputRevision;
    await act(async () => pending[0].resolve(old));
    assert.match(f.host.textContent ?? "", /Итого за заявку/);
    assert.ok(!f.host.textContent?.includes("35 500 ₽"));
    assert.match(f.host.textContent ?? "", /Проверка пройдена/);
    const documentType = f.host.querySelector<HTMLSelectElement>('select[name="p1DocType"]')!;
    await act(async () => { documentType.value = "FOREIGN_DOCUMENT"; documentType.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.match(f.host.textContent ?? "", /Итого за заявку/);
    assert.match(f.host.textContent ?? "", /Проверка пройдена/);
  } finally { await f.stop(); }
});

test("recovery bootstrap fences a remounted form and shows the durable request ID", async () => {
  const f = checkoutFixture(); const view = previewBookingView(); view.session.recoveryRequired = true; let calls = 0;
  try {
    await act(async () => f.root.render(createElement(NativeCheckout, { view, captcha: SyntheticWidget, submit: async (): Promise<BookingOutcome> => { calls++; return { kind: "unknown" }; } })));
    await f.send(); assert.equal(calls, 0);
    assert.match(f.host.textContent ?? "", /SYNTHETIC-REQUEST-NOT-LIVE/);
    assert.equal(f.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    assert.ok(!f.host.textContent?.includes("Обновить условия"));
  } finally { await f.stop(); }
});

test("a failed or mismatched refresh keeps inputs, blocks submit and offers another read-only attempt", async () => {
  const f = checkoutFixture(); let attempts = 0;
  const refreshQuote = async (request: QuoteRefreshRequest) => {
    attempts++;
    if (attempts === 1) throw new Error("SYNTHETIC_OFFLINE");
    const updated = previewBookingView(request.participantCount);
    updated.quote.inputRevision = attempts === 2 ? "WRONG-REVISION" : request.inputRevision;
    return updated;
  };
  try {
    await act(async () => f.root.render(createElement(NativeCheckout, { view: previewBookingView(), refreshQuote, captcha: SyntheticWidget })));
    const email = f.host.querySelector<HTMLInputElement>('input[name="email"]')!; email.value = "kept@example.invalid";
    await f.click("Добавить взрослого туриста");
    for (let attempt = 1; attempt <= 2; attempt++) {
      await f.click("Обновить условия");
      assert.match(f.host.textContent ?? "", /Не удалось обновить условия/);
      assert.equal(f.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
      assert.equal(email.value, "kept@example.invalid");
    }
    await f.click("Обновить условия"); assert.equal(attempts, 3);
    assert.match(f.host.textContent ?? "", /35 500 ₽/);
    assert.equal(f.host.querySelectorAll('input[name="paymentChoice"]:checked').length, 0);
  } finally { await f.stop(); }
});

test("generic TypeError remains UNKNOWN; only an explicit not-dispatched outcome permits retry", async () => {
  for (const notDispatched of [false, true]) {
    const f = checkoutFixture(); let calls = 0;
    const submit = async (): Promise<BookingOutcome> => { calls++; if (notDispatched) return { kind: "not_dispatched" }; throw new TypeError("SYNTHETIC_NETWORK_ERROR"); };
    try {
      await act(async () => f.root.render(createElement(NativeCheckout, { view: previewBookingView(), captcha: SyntheticWidget, submit })));
      await f.choose(); await f.consent(); await f.click("Solve synthetic captcha"); await f.send();
      assert.equal(calls, 1);
      if (notDispatched) { await f.click("Solve synthetic captcha"); await f.send(); assert.equal(calls, 2); }
      else { await f.send(); assert.equal(calls, 1); assert.match(f.host.textContent ?? "", /Заявка могла быть создана/); }
    } finally { await f.stop(); }
  }
});
