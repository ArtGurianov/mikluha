import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeCheckout } from "../components/booking/native-checkout";
import { bookingDraft } from "./native-checkout";
import { previewBookingView } from "../components/booking/checkout-preview-data";

test("booking presentation whitelists draft fields, not promo, money, profile or autofill noise", () => {
  const view = previewBookingView();
  const form = new FormData();
  for (const [k, v] of Object.entries({ email: " test@example.invalid ", phone: "+70000000000", p1Name: "Тестовый Турист", p1Dob: "1990-01-01", p1Citizenship: "RU", p1DocType: "RU_PASSPORT", p1DocSeries: "0000", p1DocNumber: "000000", adultsOnly: "yes", pdConsent: "yes", paymentChoice: view.quote.paymentOptions[0].ref })) form.set(k, v);
  const clean = bookingDraft(form, view, [1], "proof");
  assert.ok(clean);
  for (const field of ["promo", "promoCode", "ref", "utm_source", "arrival", "price", "discount", "profile", "paymentOwner", "termsRef", "pdConsentHash", "smart-token"]) form.set(field, "injected");
  assert.deepEqual(bookingDraft(form, view, [1], "proof"), clean);
  assert.equal(clean.contact.email, "test@example.invalid");
  assert.equal(clean.terms.ref, "PREVIEW-ONLY");
  assert.equal(clean.passengers.length, 1);
  assert.equal(bookingDraft(form, view, [], "fresh"), null);
});

test("initial checkout markup fails closed and offers no promo command or GET form fallback", () => {
  const view = previewBookingView();
  const html = renderToStaticMarkup(createElement(NativeCheckout, { view }));
  assert.match(html, /<form\b[^>]*\bmethod="post"/);
  assert.match(html, /<button type="submit" disabled=""/);
  assert.match(html, /<button type="button" disabled=""[^>]*>Применить<\/button>/);
  const promo = html.match(/<input disabled="" autoComplete="off"[^>]*>/)?.[0];
  assert.ok(promo);
  assert.ok(!promo.includes("name="));
  assert.ok(!/<script[^>]+src=.*smartcaptcha/.test(html));
  assert.match(html, /Онлайн-отправка пока недоступна/);
});

test("draft binds selected server option and quote/schema identities, whitelisting additional tourist fields", () => {
  const view = previewBookingView();
  view.touristDataSchema.fields = [{ key: "qualifiedField", label: "Synthetic qualified field", type: "text", required: true }];
  const form = new FormData();
  form.set("paymentChoice", view.quote.paymentOptions[1].ref);
  form.set("p1Extra_qualifiedField", " allowed ");
  form.set("p1Extra_undeclaredField", "ignored");
  for (const key of ["quoteRef", "quoteHash", "schemaRef", "amount", "deposit", "discount", "paymentKind"]) form.set(key, "forged");
  const draft = bookingDraft(form, view, [1], "proof");
  assert.ok(draft);
  assert.deepEqual(draft.passengers[0].additionalDetails, { qualifiedField: "allowed" });
  assert.deepEqual(draft.quote, { ref: view.quote.ref, hash: view.quote.hash });
  assert.deepEqual(draft.touristDataSchema, { ref: view.touristDataSchema.ref, hash: view.touristDataSchema.hash });
  assert.equal(draft.paymentChoiceRef, view.quote.paymentOptions[1].ref);
  assert.ok(!("amount" in draft));
});

test("stale party quote, unavailable schema and unsupported payment choice fail closed", () => {
  const view = previewBookingView();
  const form = new FormData();
  assert.equal(bookingDraft(form, view, [1], "proof"), null);
  form.set("paymentChoice", view.quote.paymentOptions[0].ref);
  assert.equal(bookingDraft(form, view, [1, 2], "proof"), null);
  view.touristDataSchema.ready = false;
  assert.equal(bookingDraft(form, view, [1], "proof"), null);
  view.touristDataSchema.ready = true;
  form.set("paymentChoice", "client-forged-deposit");
  assert.equal(bookingDraft(form, view, [1], "proof"), null);
});

test("full-only and closed presentations cannot accept a deposit command", () => {
  const early = previewBookingView();
  const fullOnly = previewBookingView(1, "full-only");
  const form = new FormData();
  form.set("paymentChoice", early.quote.paymentOptions[0].ref);
  assert.equal(bookingDraft(form, fullOnly, [1], "proof"), null);
  form.set("paymentChoice", fullOnly.quote.paymentOptions[0].ref);
  assert.ok(bookingDraft(form, fullOnly, [1], "proof"));
  assert.equal(bookingDraft(form, previewBookingView(1, "closed"), [1], "proof"), null);
});
