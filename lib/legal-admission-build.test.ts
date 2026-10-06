import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import yaml from "js-yaml";
import { normalizeContentSet } from "./cms/normalize";
import type { RawContentSet } from "./cms/types";

const root = process.cwd();
const product = { destination: "Алтай", route: "Кемерово — Алтай — Кемерово", risks: "Горная местность",
  included: "Проезд\nПроживание", program: [{ title: "День 1", items: "Отправление\nЗаселение" }] };
const departure = { departureTime: "00:30", returnTime: "21:00", departurePoint: "Тестовая точка отправления", returnPoint: "Тестовая точка возврата",
  accommodation: { name: "Тестовая гостиница", address: "Тестовый адрес", roomType: "2-местный", nights: 2, meals: "2 завтрака", legalEntity: "ИП Тестовый" },
  carrier: { legalName: "ИП Тестовый", route: "Кемерово — Алтай — Кемерово", baggage: "1 место", boarding: "По документу" },
  services: [{ name: "Экскурсия", supplier: "ИП Тестовый", included: true }] };

function fixture() {
  const collection = (name: string) => readdirSync(join(root, "content", name)).filter((f) => f.endsWith(".yml")).map((file) => ({
    ...yaml.load(readFileSync(join(root, "content", name, file), "utf8"), { schema: yaml.JSON_SCHEMA }) as object,
    _slug: file.slice(0, -4),
  }));
  const raw = { siteSettings: yaml.load(readFileSync(join(root, "content/site-settings.yml"), "utf8"), { schema: yaml.JSON_SCHEMA }),
    tours: collection("tours"), departures: collection("departures"), reports: collection("reports"),
    reviews: collection("reviews"), organizers: collection("organizers"), legalPages: collection("legal") } as RawContentSet;
  const content = normalizeContentSet(raw, "git");
  content.siteSettings.launchReady = true;
  content.siteSettings.company.isDemo = false;
  for (const d of content.departures) { d.bookingStatus = "CLOSED"; d.isDemo = false; }
  for (const r of content.reviews) r.isDemo = false;
  for (const o of content.organizers) o.isDemo = false;
  content.legalPages.find((p) => p.slug === "oferta")!.refundPolicy = "FULL_ONLY";
  const dir = mkdtempSync(join(tmpdir(), "mikluha-build-contract-"));
  mkdirSync(join(dir, ".cms-cache"));
  mkdirSync(join(dir, "public/admin"), { recursive: true });
  cpSync(join(root, "public/admin/config.yml"), join(dir, "public/admin/config.yml"));
  symlinkSync(join(root, "public/media"), join(dir, "public/media"), "dir");
  const run = () => {
    writeFileSync(join(dir, ".cms-cache/content.json"), JSON.stringify(content));
    return spawnSync(process.execPath, ["--import", join(root, "node_modules/tsx/dist/loader.mjs"), join(root, "scripts/validate-content.ts")],
      { cwd: dir, env: { ...process.env, DEPLOY_ENV: "production" }, encoding: "utf8", timeout: 10_000 });
  };
  return { content, run };
}

test("production content validation refuses unqualified or absent policy even with launchReady enabled", () => {
  const { content, run } = fixture();
  assert.equal(run().status, 0);
  const offer = content.legalPages.find((p) => p.slug === "oferta")!;
  for (const policy of ["DOCUMENTED_EXPENSES", undefined] as const) {
    if (policy === undefined) delete offer.refundPolicy;
    else offer.refundPolicy = policy;
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /REFUND_WORKFLOW_UNQUALIFIED/);
  }
});

test("production build uses the whole departure product, rejects partial overrides and ignores replaced demo defaults", () => {
  const { content, run } = fixture();
  const d = content.departures.find((x) => x.id === "altai-1")!;
  d.bookingStatus = "OPEN";
  d.isListed = true;
  const tour = content.tours.find((x) => x.id === d.tourId)!;
  tour.contract = { ...product, route: "Демо: старый маршрут" };
  d.contract = { ...departure, product };
  assert.equal(run().status, 0);
  for (const override of [null, { route: "Другой маршрут" }]) {
    d.contract = { ...departure, product: override };
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /altai-1 has incomplete tour contract data/);
  }
});

test("production build refuses missing departure time and implicit service inclusion", () => {
  const { content, run } = fixture();
  const d = content.departures.find((x) => x.id === "altai-1")!;
  d.bookingStatus = "OPEN";
  d.isListed = true;
  for (const invalid of [{ ...departure, departureTime: null },
    { ...departure, services: [{ name: "Сплав", supplier: "ИП Тестовый" }] }]) {
    d.contract = { ...invalid, product };
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /altai-1 has incomplete departure contract data/);
  }
});
