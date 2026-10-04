// The Заявка на бронирование: the individual conditions of one order, which with the public offer
// is the contract (offer §1.4, §4–5). Rendered once the final price is known, shown to the customer
// before paying exactly as stored, and frozen when they pay (migration 0003's trigger).
//
// Deterministic: the same order, contract data and offer give the same bytes, so its hash means
// "this document". The contract hash sent to Refref (legalReleaseHash) covers the offer and this.

import { createHash } from 'node:crypto';

import type { Departure } from './catalog.js';
import { countryName, type DocumentType, type Tourist } from './orders.js';
import { canonical } from './snapshot.js';

export const OPERATOR = 'ООО «ООО МИКЛУХА МАКЛАЙ», ИНН 4205435867, реестровый номер туроператора В031-00161-00/06887919';

const DOCUMENT_NAMES: Record<DocumentType, string> = {
  RU_PASSPORT: 'Паспорт гражданина РФ',
  RU_INTERNATIONAL_PASSPORT: 'Заграничный паспорт гражданина РФ',
  FOREIGN_DOCUMENT: 'Документ, удостоверяющий личность иностранного гражданина',
};

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const rub = (kopecks: number) => `${(kopecks / 100).toLocaleString('ru-RU')} ₽`;
const date = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const row = (k: string, v: string) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
const list = (xs: readonly string[]) => `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;

export interface ZayavkaInput {
  readonly orderRef: string;
  /** When it was formed, in the site's timezone, e.g. 04.10.2026 13:00. */
  readonly formedAt: string;
  readonly offerRef: string;
  readonly departure: Departure & { readonly contract: NonNullable<Departure['contract']> };
  /** The customer: tourist №1, with their phone and email. */
  readonly contact: { readonly fullName: string; readonly phone: string; readonly email: string };
  readonly tourists: readonly Tourist[];
  readonly amountKopecks: number;
  readonly discountKopecks: number;
}

export function renderZayavka(z: ZayavkaInput): string {
  const { tour, departure: dc } = z.departure.contract;
  const d = z.departure;
  const nights = dc.accommodation.nights;
  const tourists = z.tourists.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.fullName)}</td><td>${date(t.dateOfBirth)}</td>`
    + `<td>${esc(countryName(t.citizenship) ?? t.citizenship)}</td>`
    + `<td>${esc(DOCUMENT_NAMES[t.documentType])}: ${esc([t.documentSeries, t.documentNumber].filter(Boolean).join(' '))}</td></tr>`).join('');
  const services = dc.services.length === 0 ? '<p>Не предусмотрены.</p>'
    : `<table><tr><th>Услуга</th><th>Поставщик</th><th>Включено в цену</th><th>Примечание</th></tr>${dc.services.map((x) =>
      `<tr><td>${esc(x.name)}</td><td>${esc(x.supplier)}</td><td>${x.included ? 'Да' : 'Нет'}</td><td>${esc(x.note ?? '')}</td></tr>`).join('')}</table>`;
  const program = tour.program.map((day) => `<h4>${esc(day.title)}</h4>${list(day.items)}`).join('');
  return `<article class="zayavka">
<h2>Заявка на бронирование № ${esc(z.orderRef)}</h2>
<p>Индивидуальные условия туристского продукта. Неотъемлемая часть договора, заключаемого на условиях Публичной оферты.</p>
<table>${row('Номер заказа', z.orderRef)}${row('Дата и время формирования', z.formedAt)}${row('Версия Оферты', z.offerRef)}${row('Туроператор', OPERATOR)}</table>
<h3>1. Заказчик</h3>
<table>${row('ФИО', z.contact.fullName)}${row('Телефон', z.contact.phone)}${row('E-mail', z.contact.email)}${row('Заказчик является туристом', 'Да, турист № 1')}</table>
<h3>2. Туристы</h3>
<table><tr><th>№</th><th>ФИО</th><th>Дата рождения</th><th>Гражданство</th><th>Документ, удостоверяющий личность</th></tr>${tourists}</table>
<h3>3. Туристский продукт</h3>
<table>${row('Название тура', d.tourTitle)}${row('Регион / место временного пребывания', tour.destination)}${row('Даты', `${date(d.startsOn)} — ${date(d.endsOn)}`)}${row('Продолжительность', `${nights + 1} дн. / ${nights} ноч.`)}${row('Маршрут', tour.route)}${row('Место и время отправления', dc.departurePoint)}${row('Место и ориентировочное время возвращения', dc.returnPoint)}</table>
<h4>3.1. Размещение</h4>
<table>${row('Средство размещения', dc.accommodation.name)}${row('Адрес', dc.accommodation.address)}${row('Категория', dc.accommodation.category ?? 'Не присвоена / не применимо')}${dc.accommodation.registryNumber ? row('Номер в реестре средств размещения', dc.accommodation.registryNumber) : ''}${row('Тип номера / размещения', dc.accommodation.roomType)}${row('Ночей', String(nights))}${row('Питание', dc.accommodation.meals)}${row('Поставщик услуги размещения', dc.accommodation.legalEntity)}</table>
<h4>3.2. Перевозка</h4>
<table>${row('Вид перевозки', 'Заказная автобусная перевозка')}${row('Перевозчик / фрахтовщик', dc.carrier.legalName)}${row('Маршрут перевозки', dc.carrier.route)}${dc.carrier.vehicle ? row('Транспортное средство / класс', dc.carrier.vehicle) : ''}${row('Условия багажа', dc.carrier.baggage)}${row('Посадка', dc.carrier.boarding)}</table>
<h4>3.3. Экскурсии и дополнительные услуги</h4>
${services}
<h3>4. Программа тура</h3>
${program}
<h3>5. Цена и оплата</h3>
<table>${row('Общая цена туристского продукта', rub(z.amountKopecks))}${z.discountKopecks > 0 ? row('Скидка по приглашению', rub(z.discountKopecks)) : ''}${row('К оплате', rub(z.amountKopecks - z.discountKopecks))}${row('Порядок оплаты', '100% предварительная оплата')}</table>
<h3>6. Что включено / не включено</h3>
<p>Включено в цену:</p>${list(tour.included)}
<p>Не включено в цену:</p>${tour.excluded.length === 0 ? '<p>—</p>' : list(tour.excluded)}
<h3>7. Добровольное страхование туриста</h3>
<p>${esc(tour.insurance ?? 'Добровольное медицинское страхование, страхование от несчастного случая и от отмены поездки в цену не включено.')}</p>
<h3>8. Характерные риски и важная информация</h3>
<p>${esc(tour.risks)}</p>
<h3>9. Акцепт</h3>
<p>Успешная оплата заказа подтверждает согласие Заказчика с условиями настоящей Заявки и Публичной оферты в версии ${esc(z.offerRef)}.</p>
</article>`;
}

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The contract hash sent to Refref as legalReleaseHash: the offer's version and hash and this
 * order's Заявка, in canonical form. It binds the paid deal to exactly the documents accepted.
 */
export function contractHash(offerRef: string, offerHash: string, zayavkaSha256: string): string {
  return `sha256:${sha256Hex(canonical({ schema: 'mikluha.contract/1', offerRef, offerHash, zayavka: `sha256:${zayavkaSha256}` }))}`;
}
