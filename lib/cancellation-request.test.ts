import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CancellationRequest } from "../components/booking/cancellation-request";
import { cancellationDraft, canRequestCancellation, selectedCancellableRefs } from "./cancellation-request";
import { previewCancellationView } from "../components/booking/cancellation-preview-data";

function filledForm(extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries({ reasonCategory: "VOLUNTARY", reasonDetails: "Не смогу поехать.", email: " test@example.invalid ", phone: "+70000000000", policyAcknowledged: "yes", ...extra })) form.set(k, v);
  return form;
}

test("cancellation draft whitelists fields, never money, percentage, retained cost, bank or partner noise", () => {
  const view = previewCancellationView("voluntary-early");
  const clean = cancellationDraft(filledForm(), view, ["seat-1"], "proof");
  assert.ok(clean);
  for (const field of ["refundAmount", "refundPercent", "retainedExpenses", "commission", "C", "E", "cardNumber", "iban", "bankCode", "promo", "partner", "utm_source", "profile", "policyHash", "orderRef"]) filledForm().set(field, "injected");
  const withNoise = filledForm();
  for (const field of ["refundAmount", "refundPercent", "retainedExpenses", "commission", "cardNumber", "iban", "bankCode", "promo", "partner"]) withNoise.set(field, "injected");
  assert.deepEqual(cancellationDraft(withNoise, view, ["seat-1"], "proof"), clean);
  assert.equal(clean.contact.email, "test@example.invalid");
  assert.equal(clean.orderRef, "PREVIEW-0001");
  assert.equal(clean.policy.ref, "otkaz-i-vozvrat");
  assert.deepEqual(clean.scope, { wholeBooking: false, participantRefs: ["seat-1"] });
  assert.equal(Object.prototype.hasOwnProperty.call(clean, "money"), false);
});

test("draft binds only still-cancellable selected participants and ignores unknown or closed seats", () => {
  const view = previewCancellationView("voluntary-early");
  // seat-3 is not cancellable, seat-9 does not exist.
  const draft = cancellationDraft(filledForm(), view, ["seat-2", "seat-3", "seat-9"], "proof");
  assert.ok(draft);
  assert.deepEqual(draft.scope.participantRefs, ["seat-2"]);
  assert.deepEqual(selectedCancellableRefs(view, ["seat-1", "seat-3"]), ["seat-1"]);
});

test("draft is null without a cancellable selection, proof, acknowledgement, reason or contact", () => {
  const view = previewCancellationView("voluntary-early");
  assert.equal(cancellationDraft(filledForm(), view, [], "proof"), null);
  assert.equal(cancellationDraft(filledForm(), view, ["seat-3"], "proof"), null);
  assert.equal(cancellationDraft(filledForm(), view, ["seat-1"], ""), null);
  assert.equal(cancellationDraft(filledForm({ policyAcknowledged: "" }), view, ["seat-1"], "proof"), null);
  assert.equal(cancellationDraft(filledForm({ reasonCategory: "NOT_A_CATEGORY" }), view, ["seat-1"], "proof"), null);
  assert.equal(cancellationDraft(filledForm({ reasonDetails: "" }), view, ["seat-1"], "proof"), null);
  assert.equal(cancellationDraft(filledForm({ email: "" }), view, ["seat-1"], "proof"), null);
});

test("whole-booking-only state composes a whole-booking scope without per-seat selection", () => {
  const view = previewCancellationView("whole-only");
  assert.equal(view.wholeBookingOnly, true);
  assert.equal(canRequestCancellation(view), true);
  const draft = cancellationDraft(filledForm(), view, [], "proof");
  assert.ok(draft);
  assert.deepEqual(draft.scope, { wholeBooking: true, participantRefs: [] });
});

test("nothing-cancellable state reports unavailable and composes no draft", () => {
  const view = previewCancellationView("nothing-cancellable");
  assert.equal(canRequestCancellation(view), false);
  assert.equal(cancellationDraft(filledForm(), view, ["seat-1", "seat-2"], "proof"), null);
});

test("initial markup fails closed: POST form, disabled submit, no backend promise, no captcha script", () => {
  const view = previewCancellationView("voluntary-early");
  const html = renderToStaticMarkup(createElement(CancellationRequest, { view }));
  assert.match(html, /<form\b[^>]*\bmethod="post"/);
  assert.match(html, /<button type="submit" disabled=""/);
  assert.match(html, /Онлайн-отправка заявления пока недоступна/);
  assert.match(html, /не возвращает деньги/);
  // Indicative figure must be framed as a voluntary offer, not a fixed penalty.
  assert.match(html, /Ориентировочный возврат/);
  assert.ok(!/<script[^>]+src=.*smartcaptcha/.test(html));
});

test("final-amount state drops the indicative framing", () => {
  const view = previewCancellationView("final-amount");
  assert.equal(view.money.indicative, false);
  const html = renderToStaticMarkup(createElement(CancellationRequest, { view }));
  assert.match(html, /Возврат к перечислению/);
  assert.ok(!html.includes("Ориентировочный возврат"));
});
