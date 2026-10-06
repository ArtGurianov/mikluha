import assert from "node:assert/strict";
import { test } from "node:test";

import { demoContractFields, effectiveProduct, hasCompleteDepartureContract, hasCompleteTourContract, hasQualifiedRefundPolicy } from "./contract-readiness";

const tour = {
  destination: "Республика Алтай",
  route: "Кемерово — Артыбаш — Кемерово",
  program: [{ title: "День 1", items: "Отправление\nЗаселение" }],
  included: "Проезд\nПроживание",
  excluded: "Обеды",
  risks: "Горная местность",
};

const departure = {
  departureTime: "06:00", returnTime: "21:00",
  departurePoint: "Кемерово, 06:00",
  returnPoint: "Кемерово, около 21:00",
  accommodation: {
    name: "Гостевой дом",
    address: "с. Артыбаш",
    roomType: "Двухместный номер",
    nights: 3,
    meals: "Завтраки",
    legalEntity: "ИП Поставщик",
  },
  carrier: {
    legalName: "ООО Перевозчик",
    route: "Кемерово — Артыбаш — Кемерово",
    baggage: "Одно место",
    boarding: "За 20 минут по документу",
  },
  services: [{ name: "Экскурсия", supplier: "ИП Поставщик", included: true }],
};

test("contract readiness mirrors the commerce completeness boundary", () => {
  assert.equal(hasCompleteTourContract(tour), true);
  assert.equal(hasCompleteTourContract({ ...tour, risks: "" }), false);
  assert.equal(hasCompleteDepartureContract(departure), true);
  assert.equal(hasCompleteDepartureContract({ ...departure, carrier: { ...departure.carrier, baggage: "" } }), false);
});

test("a departure product replaces defaults completely and an incomplete override stays incomplete", () => {
  const product = { ...tour, route: "Другой маршрут" };
  assert.equal(effectiveProduct(tour, { product }), product);
  assert.equal(effectiveProduct(tour, departure), tour);
  assert.equal(hasCompleteTourContract(effectiveProduct(tour, { product: { route: "Другой маршрут" } })), false);
  assert.equal(hasCompleteTourContract(effectiveProduct(tour, { product: null })), false);
});

test("exact times and explicit service inclusion are required", () => {
  for (const invalid of [undefined, "24:00", "06:60", "morning"]) {
    assert.equal(hasCompleteDepartureContract({ ...departure, departureTime: invalid }), false);
    assert.equal(hasCompleteDepartureContract({ ...departure, returnTime: invalid }), false);
  }
  assert.equal(hasCompleteDepartureContract({ ...departure, services: [{ name: "Экскурсия", supplier: "ИП Поставщик" }] }), false);
});

test("documented-expense refunds cannot be admitted through a configuration flag", () => {
  assert.equal(hasQualifiedRefundPolicy('FULL_ONLY'), true);
  for (const value of ['DOCUMENTED_EXPENSES', undefined, true, 'qualified']) assert.equal(hasQualifiedRefundPolicy(value), false);
});

test("an explicit demo marker is found anywhere in a sellable contract", () => {
  assert.deepEqual(demoContractFields({ ...tour, program: [{ title: "День 1", items: "Демо: отправление" }] }), [
    "contract.program[0].items",
  ]);
  assert.deepEqual(demoContractFields({ destination: "Демонстрационный зал" }), []);
});
