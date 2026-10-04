import assert from "node:assert/strict";
import { test } from "node:test";

import { demoContractFields, hasCompleteDepartureContract, hasCompleteTourContract } from "./contract-readiness";

const tour = {
  destination: "Республика Алтай",
  route: "Кемерово — Артыбаш — Кемерово",
  program: [{ title: "День 1", items: "Отправление\nЗаселение" }],
  included: "Проезд\nПроживание",
  excluded: "Обеды",
  risks: "Горная местность",
};

const departure = {
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

test("an explicit demo marker is found anywhere in a sellable contract", () => {
  assert.deepEqual(demoContractFields({ ...tour, program: [{ title: "День 1", items: "Демо: отправление" }] }), [
    "contract.program[0].items",
  ]);
  assert.deepEqual(demoContractFields({ destination: "Демонстрационный зал" }), []);
});
