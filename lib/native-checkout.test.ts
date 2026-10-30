import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeCheckout } from "../components/booking/native-checkout";
import { bookingDraft, quotePricingInputs } from "./native-checkout";
import { previewBookingView } from "../components/booking/checkout-preview-data";

test("booking presentation whitelists draft fields, not promo, money, profile or autofill noise", () => {
  const view = previewBookingView();
  const form = new FormData();
  form.set("adultsOnly", "yes"); form.set("pdConsent", "yes");
  for (const [k, v] of Object.entries({ email: " test@example.invalid ", phone: "+70000000000", p1Name: "Тестовый Турист", p1Dob: "1990-01-01", p1Citizenship: "RU", p1DocType: "RU_PASSPORT", p1DocSeries: "0000", p1DocNumber: "000000", adultsOnly: "yes", pdConsent: "yes", paymentChoice: view.quote.paymentOptions[0].ref })) form.set(k, v);
  const clean = bookingDraft(form, view, [1], "proof", view.quote.inputRevision);
  assert.ok(clean);
  for (const field of ["promo", "promoCode", "ref", "utm_source", "arrival", "price", "discount", "profile", "paymentOwner", "termsRef", "pdConsentHash", "smart-token"]) form.set(field, "injected");
  assert.deepEqual(bookingDraft(form, view, [1], "proof", view.quote.inputRevision), clean);
  assert.equal(clean.contact.email, "test@example.invalid");
  assert.equal(clean.terms.ref, "PREVIEW-ONLY");
  assert.equal(clean.passengers.length, 1);
  assert.equal(bookingDraft(form, view, [], "fresh", view.quote.inputRevision), null);
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
  form.set("adultsOnly", "yes"); form.set("pdConsent", "yes");
  form.set("paymentChoice", view.quote.paymentOptions[1].ref);
  form.set("p1Extra_qualifiedField", " allowed ");
  form.set("p1Extra_undeclaredField", "ignored");
  for (const key of ["quoteRef", "quoteHash", "schemaRef", "amount", "deposit", "discount", "paymentKind"]) form.set(key, "forged");
  const draft = bookingDraft(form, view, [1], "proof", view.quote.inputRevision);
  assert.ok(draft);
  assert.deepEqual(draft.passengers[0].additionalDetails, { qualifiedField: "allowed" });
  assert.deepEqual(draft.quote, { ref: view.quote.ref, hash: view.quote.hash, inputRevision: view.quote.inputRevision });
  assert.deepEqual(draft.touristDataSchema, { ref: view.touristDataSchema.ref, hash: view.touristDataSchema.hash });
  assert.equal(draft.paymentChoiceRef, view.quote.paymentOptions[1].ref);
  assert.ok(!("amount" in draft));
});

test("stale party quote, unavailable schema and unsupported payment choice fail closed", () => {
  const view = previewBookingView();
  const form = new FormData();
  form.set("adultsOnly", "yes"); form.set("pdConsent", "yes");
  assert.equal(bookingDraft(form, view, [1], "proof", view.quote.inputRevision), null);
  form.set("paymentChoice", view.quote.paymentOptions[0].ref);
  assert.equal(bookingDraft(form, view, [1, 2], "proof", view.quote.inputRevision), null);
  view.touristDataSchema.ready = false;
  assert.equal(bookingDraft(form, view, [1], "proof", view.quote.inputRevision), null);
  view.touristDataSchema.ready = true;
  form.set("paymentChoice", "client-forged-deposit");
  assert.equal(bookingDraft(form, view, [1], "proof", view.quote.inputRevision), null);
});

test("full-only and closed presentations cannot accept a deposit command", () => {
  const early = previewBookingView();
  const fullOnly = previewBookingView(1, "full-only");
  const form = new FormData();
  form.set("adultsOnly", "yes"); form.set("pdConsent", "yes");
  form.set("paymentChoice", early.quote.paymentOptions[0].ref);
  assert.equal(bookingDraft(form, fullOnly, [1], "proof", fullOnly.quote.inputRevision), null);
  form.set("paymentChoice", fullOnly.quote.paymentOptions[0].ref);
  assert.ok(bookingDraft(form, fullOnly, [1], "proof", fullOnly.quote.inputRevision));
  assert.equal(bookingDraft(form, previewBookingView(1, "closed"), [1], "proof", early.quote.inputRevision), null);
});

test("draft rejects missing consents, stale input revision and recovery bootstrap; ID comes from trusted session", () => {
  const view = previewBookingView();
  const form = new FormData();
  form.set("paymentChoice", view.quote.paymentOptions[0].ref);
  form.set("clientRequestId", "FORGED");
  assert.equal(bookingDraft(form, view, [1], "proof", view.quote.inputRevision), null);
  form.set("adultsOnly", "yes");
  assert.equal(bookingDraft(form, view, [1], "proof", view.quote.inputRevision), null);
  form.set("pdConsent", "yes");
  assert.equal(bookingDraft(form, view, [1], "proof", view.quote.inputRevision)?.clientRequestId, view.session.clientRequestId);
  assert.equal(bookingDraft(form, view, [1], "proof", "NEW-INPUT"), null);
  view.session.recoveryRequired = true;
  assert.equal(bookingDraft(form, view, [1], "proof", view.quote.inputRevision), null);
});

test("quote projection defaults to party count and includes only qualified pricing fields", () => {
  const view = previewBookingView(); const form = new FormData();
  for (const [key, value] of Object.entries({ p1Name: "Synthetic Name", p1DocType: "RU_PASSPORT", p1DocNumber: "SYNTHETIC-DOCUMENT",
    p1Dob: "1990-01-01", p1Citizenship: "RU", p1Extra_band: "standard", p1Extra_privateNote: "Synthetic private note",
    email: "synthetic@example.invalid", priceAffecting: "p1DocNumber" })) form.set(key, value);
  assert.deepEqual(quotePricingInputs(form, view, [1]), { participantCount: 1 });
  view.touristDataSchema.priceAffectingBaseFields = ["citizenship"];
  view.touristDataSchema.fields = [
    { key: "band", label: "Synthetic pricing category", type: "text", required: false, priceAffecting: true },
    { key: "privateNote", label: "Not a price input", type: "text", required: false },
  ];
  assert.deepEqual(quotePricingInputs(form, view, [1]), { participantCount: 1, pricingInputs: [{ citizenship: "RU", additionalDetails: { band: "standard" } }] });
  view.touristDataSchema.ready = false;
  assert.deepEqual(quotePricingInputs(form, view, [1]), { participantCount: 1 });
});
