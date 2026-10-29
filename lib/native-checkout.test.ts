import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeCheckout } from "../components/booking/native-checkout";
import { bookingDraft, type BookingPresentation } from "./native-checkout";

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

test("initial checkout markup fails closed and offers no promo command or GET form fallback", () => {
  const view: BookingPresentation = {
    departureId: "fixture", title: "Fixture", dateLabel: "Date", departureLabel: "Place", priceLabel: "18 000 ₽",
    paymentLabel: "Deposit", paymentDetail: "Details", maxParticipants: 4,
    terms: { ref: "terms-1", hash: "terms-hash" }, pdConsent: { ref: "pd-1", hash: "pd-hash" },
  };
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
