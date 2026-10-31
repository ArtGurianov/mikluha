import { dom } from "./test-support/dom-setup";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { CancellationRequest } from "../components/booking/cancellation-request";
import { cancellationDraft, canRequestCancellation, selectedCancellableRefs } from "./cancellation-request";
import type { CancellationOutcome, CancellationPresentation } from "./cancellation-request";
import { previewCancellationView } from "../components/booking/cancellation-preview-data";
import type { CaptchaWidgetProps } from "../components/booking/smartcaptcha";

function filledForm(extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries({ customerName: "Иванов Иван Иванович", reasonCategory: "VOLUNTARY", reasonDetails: "Не смогу поехать.", email: " test@example.invalid ", phone: "+70000000000", policyAcknowledged: "yes", ...extra })) form.set(k, v);
  return form;
}

test("cancellation draft whitelists fields, never money, percentage, retained cost, bank or partner noise", () => {
  const view = previewCancellationView("voluntary-early");
  const clean = cancellationDraft(filledForm(), view, ["seat-1"], "proof");
  assert.ok(clean);
  const withNoise = filledForm();
  for (const field of ["refundAmount", "refundPercent", "retainedExpenses", "commission", "C", "E", "cardNumber", "iban", "bankCode", "promo", "partner", "utm_source", "profile", "policyHash", "orderRef"]) withNoise.set(field, "injected");
  assert.deepEqual(cancellationDraft(withNoise, view, ["seat-1"], "proof"), clean);
  assert.equal(clean.contact.email, "test@example.invalid");
  assert.equal(clean.applicant.fullName, "Иванов Иван Иванович");
  assert.equal(clean.orderRef, "PREVIEW-0001");
  assert.equal(clean.policy.ref, "otkaz-i-vozvrat");
  assert.deepEqual(clean.scope, { wholeBooking: false, participantRefs: ["seat-1"] });
  assert.equal(Object.prototype.hasOwnProperty.call(clean, "money"), false);
});

test("a forged scope=whole cannot widen a per-tourist refusal into the whole booking", () => {
  const view = previewCancellationView("voluntary-early");
  assert.equal(view.wholeBookingOnly, false);
  const draft = cancellationDraft(filledForm({ scope: "whole" }), view, ["seat-1"], "proof");
  assert.ok(draft);
  assert.deepEqual(draft.scope, { wholeBooking: false, participantRefs: ["seat-1"] });
});

test("draft binds only still-cancellable selected participants and ignores unknown or closed seats", () => {
  const view = previewCancellationView("voluntary-early");
  // seat-3 is not cancellable, seat-9 does not exist.
  const draft = cancellationDraft(filledForm(), view, ["seat-2", "seat-3", "seat-9"], "proof");
  assert.ok(draft);
  assert.deepEqual(draft.scope.participantRefs, ["seat-2"]);
  assert.deepEqual(selectedCancellableRefs(view, ["seat-1", "seat-3"]), ["seat-1"]);
});

test("draft is null without a cancellable selection, proof, name, acknowledgement, reason or contact", () => {
  const view = previewCancellationView("voluntary-early");
  assert.equal(cancellationDraft(filledForm(), view, [], "proof"), null);
  assert.equal(cancellationDraft(filledForm(), view, ["seat-3"], "proof"), null);
  assert.equal(cancellationDraft(filledForm(), view, ["seat-1"], ""), null);
  assert.equal(cancellationDraft(filledForm({ customerName: "" }), view, ["seat-1"], "proof"), null);
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
  assert.match(html, /ФИО заказчика/);
  // Target response time must stay an effort, not an unconditional promise.
  assert.match(html, /стремится сообщить расчёт/);
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

function SyntheticWidget({ onToken }: CaptchaWidgetProps) {
  return createElement("button", { type: "button", onClick: () => onToken("synthetic-proof") }, "Solve synthetic captcha");
}

/** Fills the required inputs and selects the first cancellable seat so a draft can compose. */
async function prepare(host: HTMLElement) {
  host.querySelector<HTMLInputElement>('input[name="customerName"]')!.value = "Синтетический Заказчик";
  host.querySelector<HTMLInputElement>('input[name="email"]')!.value = "synthetic@example.invalid";
  host.querySelector<HTMLInputElement>('input[name="phone"]')!.value = "+70000000000";
  host.querySelector<HTMLTextAreaElement>('textarea[name="reasonDetails"]')!.value = "Синтетическая причина.";
  host.querySelector<HTMLSelectElement>('select[name="reasonCategory"]')!.value = "VOLUNTARY";
  await act(async () => {
    host.querySelector<HTMLInputElement>('input[name="participant"]')!.click();
    host.querySelector<HTMLInputElement>('input[name="policyAcknowledged"]')!.click();
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Solve synthetic captcha")!.click();
  });
}

test("one in-flight submit, fenced UNKNOWN resubmission and a locked received state", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const view = previewCancellationView("voluntary-early");
  let finish!: (outcome: CancellationOutcome) => void;
  let calls = 0;
  const submit = async () => { calls++; return new Promise<CancellationOutcome>((resolve) => { finish = resolve; }); };
  const dispatch = () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  try {
    await act(async () => root.render(createElement(CancellationRequest, { view, captcha: SyntheticWidget, submit })));
    await prepare(host);
    const name = host.querySelector<HTMLInputElement>('input[name="customerName"]')!;
    await act(async () => { dispatch(); dispatch(); });
    assert.equal(calls, 1);
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    await act(async () => finish({ kind: "unknown" }));
    // Inputs survive and resubmission is blocked because the application may have been received.
    assert.equal(name.value, "Синтетический Заказчик");
    assert.match(host.textContent ?? "", /Заявление могло быть принято/);
    await act(async () => { dispatch(); });
    assert.equal(calls, 1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("rejection keeps inputs and needs a fresh proof; received shows the reference and locks the form", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const view = previewCancellationView("voluntary-early");
  let calls = 0;
  let outcome: CancellationOutcome = { kind: "rejected", code: "CAPTCHA_INVALID" };
  const submit = async () => { calls++; return outcome; };
  const dispatch = () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  const clickProof = async () => { await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Solve synthetic captcha")!.click()); };
  try {
    await act(async () => root.render(createElement(CancellationRequest, { view, captcha: SyntheticWidget, submit })));
    await prepare(host);
    await act(async () => { dispatch(); });
    assert.equal(calls, 1);
    // The proof was consumed on submit; without a fresh one the form cannot resend.
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    assert.match(host.textContent ?? "", /Проверка безопасности не принята/);
    await act(async () => { dispatch(); });
    assert.equal(calls, 1);
    outcome = { kind: "received", reference: "REF-TEST-01" };
    await clickProof();
    await act(async () => { dispatch(); });
    assert.equal(calls, 2);
    assert.match(host.textContent ?? "", /REF-TEST-01/);
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    await act(async () => { dispatch(); });
    assert.equal(calls, 2);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("not_dispatched allows a retry with a fresh proof; refresh_required and expired proof block resend", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const view = previewCancellationView("voluntary-early");
  let calls = 0;
  let outcome: CancellationOutcome = { kind: "not_dispatched" };
  const submit = async () => { calls++; return outcome; };
  const dispatch = () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  const clickProof = async () => { await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Solve synthetic captcha")!.click()); };
  try {
    await act(async () => root.render(createElement(CancellationRequest, { view, captcha: SyntheticWidget, submit })));
    await prepare(host);
    await act(async () => { dispatch(); });
    assert.equal(calls, 1);
    assert.match(host.textContent ?? "", /Заявление не было отправлено/);
    // not_dispatched returns to editing; a fresh proof permits exactly one more send.
    outcome = { kind: "refresh_required", code: "SCOPE_STALE" };
    await clickProof();
    await act(async () => { dispatch(); });
    assert.equal(calls, 2);
    assert.match(host.textContent ?? "", /Состояние заказа или правила возврата изменились/);
    // refresh_required leaves the status out of "editing", so another dispatch sends nothing.
    await act(async () => { dispatch(); });
    assert.equal(calls, 2);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("a changed session/order remounts the form and clears a prior received state", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const first = previewCancellationView("voluntary-early");
  const submit = async (): Promise<CancellationOutcome> => ({ kind: "received", reference: "REF-TEST-02" });
  const dispatch = () => host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  try {
    await act(async () => root.render(createElement(CancellationRequest, { view: first, captcha: SyntheticWidget, submit })));
    await prepare(host);
    await act(async () => { dispatch(); });
    assert.match(host.textContent ?? "", /REF-TEST-02/);
    assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    // A different application (new session id + order) must not inherit the received lock.
    const second: CancellationPresentation = { ...first, session: { clientRequestId: "OTHER-REQUEST", recoveryRequired: false }, orderRef: "PREVIEW-0002" };
    await act(async () => root.render(createElement(CancellationRequest, { view: second, captcha: SyntheticWidget, submit })));
    assert.match(host.textContent ?? "", /Заказ № PREVIEW-0002/);
    assert.ok(!host.textContent?.includes("REF-TEST-02"));
    const resubmit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    assert.match(resubmit.textContent ?? "", /Отправить заявление об отказе/);
    // Fresh mount: no proof/selection yet, so submit starts disabled.
    assert.equal(resubmit.disabled, true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
