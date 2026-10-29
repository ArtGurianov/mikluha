import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeCheckout } from "../components/booking/native-checkout";
import { bookingDraft, type BookingPresentation } from "./native-checkout";
import { smartCaptchaMount, type CaptchaEvent, type SmartCaptchaApi } from "./smartcaptcha-widget";

test("booking presentation whitelists draft fields, not promo, money, profile or autofill noise", () => {
  const view: BookingPresentation = {
    departureId: "fixture", title: "Fixture", dateLabel: "Date", departureLabel: "Place", priceLabel: "18 000 ₽",
    paymentLabel: "Deposit", paymentDetail: "Details", maxParticipants: 4,
    terms: { ref: "terms-1", hash: "terms-hash" }, pdConsent: { ref: "pd-1", hash: "pd-hash" },
  };
  const form = new FormData();
  for (const [k, v] of Object.entries({ email: " test@example.invalid ", phone: "+70000000000", p1Name: "Тестовый Турист", p1Dob: "1990-01-01", p1Citizenship: "RU", p1DocType: "RU_PASSPORT", p1DocSeries: "0000", p1DocNumber: "000000", adultsOnly: "yes", pdConsent: "yes" })) form.set(k, v);
  const clean = bookingDraft(form, view, [1], "proof");
  for (const field of ["promo", "promoCode", "ref", "utm_source", "arrival", "price", "discount", "profile", "paymentOwner", "termsRef", "pdConsentHash", "smart-token"]) form.set(field, "injected");
  assert.deepEqual(bookingDraft(form, view, [1], "proof"), clean);
  assert.equal(clean.contact.email, "test@example.invalid");
  assert.equal(clean.terms.ref, "terms-1");
  assert.equal(clean.passengers.length, 1);
  assert.equal(bookingDraft(form, view, [], "fresh").passengers.length, 0);
});

function fakeApi() {
  const events = new Map<string, () => void>();
  let solved: (token: string) => void = () => {};
  let destroyed = 0;
  let removed = 0;
  const api: SmartCaptchaApi = {
    render(_node, options) { solved = options.callback; return 42; },
    subscribe(id, event, callback) { assert.equal(id, 42); events.set(event, callback); return () => { removed++; }; },
    destroy(id) { assert.equal(id, 42); destroyed++; },
  };
  return { api, events, solve: (token: string) => solved(token), disposed: () => ({ destroyed, removed }) };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const container = {} as HTMLElement;

test("captcha invalidates expired/failed proofs, ignores late success after fatal error and cleans listeners", async () => {
  const fake = fakeApi();
  const received: CaptchaEvent[] = [];
  const cleanup = smartCaptchaMount("public-key", async () => fake.api)(container, (event) => received.push(event));
  await flush();
  fake.solve("proof-1");
  fake.events.get("token-expired")!();
  fake.solve("proof-2");
  fake.events.get("javascript-error")!();
  fake.solve("late-proof");
  assert.deepEqual(received, [{ kind: "ready" }, { kind: "solved", token: "proof-1" }, { kind: "expired" }, { kind: "solved", token: "proof-2" }, { kind: "unavailable" }]);
  cleanup();
  fake.solve("after-unmount");
  assert.equal(received.length, 5);
  assert.deepEqual(fake.disposed(), { destroyed: 1, removed: 3 });
});

test("unmount while loading never renders a stale widget; loading failure can be retried", async () => {
  const fake = fakeApi();
  let resolveLoad!: (api: SmartCaptchaApi) => void;
  const pending = new Promise<SmartCaptchaApi>((resolve) => { resolveLoad = resolve; });
  const received: CaptchaEvent[] = [];
  const cleanup = smartCaptchaMount("public-key", () => pending)(container, (event) => received.push(event));
  cleanup();
  resolveLoad(fake.api);
  await flush();
  assert.deepEqual(received, []);
  const failed: CaptchaEvent[] = [];
  smartCaptchaMount("public-key", async () => { throw new Error("network"); })(container, (event) => failed.push(event));
  await flush();
  assert.deepEqual(failed, [{ kind: "unavailable" }]);
  const retry: CaptchaEvent[] = [];
  const stop = smartCaptchaMount("public-key", async () => fake.api)(container, (event) => retry.push(event));
  await flush();
  assert.deepEqual(retry, [{ kind: "ready" }]);
  fake.events.get("network-error")!();
  assert.deepEqual(retry.at(-1), { kind: "unavailable" });
  stop();
});

test("missing site key fails closed without fetching any provider script", () => {
  const received: CaptchaEvent[] = [];
  smartCaptchaMount(" ", async () => { assert.fail("no provider call"); })(container, (event) => received.push(event))();
  assert.deepEqual(received, [{ kind: "unavailable" }]);
});

test("initial checkout markup fails closed and offers no promo command or GET form fallback", () => {
  const view: BookingPresentation = {
    departureId: "fixture", title: "Fixture", dateLabel: "Date", departureLabel: "Place", priceLabel: "18 000 ₽",
    paymentLabel: "Deposit", paymentDetail: "Details", maxParticipants: 4,
    terms: { ref: "terms-1", hash: "terms-hash" }, pdConsent: { ref: "pd-1", hash: "pd-hash" },
  };
  const html = renderToStaticMarkup(createElement(NativeCheckout, { view }));
  assert.match(html, /<form method="post"/);
  assert.match(html, /<button type="submit" disabled=""/);
  assert.match(html, /<button type="button" disabled=""[^>]*>Применить<\/button>/);
  const promo = html.match(/<input disabled="" autoComplete="off"[^>]*>/)?.[0];
  assert.ok(promo);
  assert.ok(!promo.includes("name="));
  assert.ok(!/<script[^>]+src=.*smartcaptcha/.test(html));
  assert.match(html, /Онлайн-отправка пока недоступна/);
});
