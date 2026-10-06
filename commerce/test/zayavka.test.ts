import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contractHash, renderZayavka, sha256Hex, type ZayavkaInput } from '../src/zayavka.js';
import { fixtureCatalog } from './helpers.js';

function input(): ZayavkaInput {
  const d = fixtureCatalog([{ slug: 'altai-1', startsOn: '2026-10-29', endsOn: '2026-11-01', price: 26500 }]).departures.get('altai-1')!;
  assert.ok(d.contract);
  return { orderRef: 'mk-abcdefghijkl', formedAt: '06.10.2026 12:00', timezone: 'Asia/Krasnoyarsk', offerRef: 'oferta@2026-10-06',
    departure: { ...d, contract: { ...d.contract, departure: { ...d.contract.departure, departureTime: '00:30', returnTime: '21:00',
      accommodation: { ...d.contract.departure.accommodation, nights: 2, meals: '2 завтрака, 2 ужина' },
      services: [{ name: 'Сплав', supplier: 'ИП Исполнитель', included: false, note: 'Оплачивается отдельно' }] } } },
    contact: { fullName: 'Иван Петров', phone: '+7 900 000 0000', email: 'synthetic@example.ru' },
    tourists: [{ fullName: 'Иван Петров', dateOfBirth: '1990-05-17', citizenship: 'RU', documentType: 'RU_PASSPORT',
      documentSeries: '0000', documentNumber: '000001' }], amountKopecks: 2_650_000, discountKopecks: 0 };
}

test('one generic offer binds exact individual application without confusing calendar days and accommodation nights', () => {
  const z = input();
  const html = renderZayavka(z);
  for (const fact of ['altai-1', '29.10.2026 00:30 (Asia/Krasnoyarsk)', '01.11.2026 21:00 (Asia/Krasnoyarsk)',
    '4 календарных дн. / 2 ноч. размещения', '2 завтрака, 2 ужина', 'Оплачивается отдельно', '100% предварительная оплата',
    'Добровольное медицинское страхование, страхование от несчастного случая и от отмены поездки в цену не включено.']) assert.ok(html.includes(fact), fact);
  assert.match(html, /ИП Исполнитель<\/td><td>Нет/);
  assert.ok(html.includes((26500).toLocaleString('ru-RU')));
  assert.equal(sha256Hex(html), sha256Hex(renderZayavka(z)));
});

test('time, departure, program, living/meal terms, inclusions and price all change the frozen tourism hash, not the generic offer', () => {
  const z = input();
  const dc = z.departure.contract.departure;
  const tc = z.departure.contract.tour;
  const baseline = contractHash(z.offerRef, 'sha256:' + 'a'.repeat(64), sha256Hex(renderZayavka(z)));
  const variants: ZayavkaInput[] = [
    { ...z, amountKopecks: z.amountKopecks + 100 },
    { ...z, departure: { ...z.departure, slug: 'altai-2' } },
    { ...z, departure: { ...z.departure, contract: { tour: tc, departure: { ...dc, departureTime: '01:00' } } } },
    { ...z, departure: { ...z.departure, contract: { tour: { ...tc, route: 'Другой маршрут' }, departure: dc } } },
    { ...z, departure: { ...z.departure, contract: { tour: { ...tc, program: [{ title: 'Другой день', items: ['Другой маршрут'] }] }, departure: dc } } },
    { ...z, departure: { ...z.departure, contract: { tour: tc, departure: { ...dc, accommodation: { ...dc.accommodation, roomType: 'Одноместный', meals: 'Без питания' } } } } },
    { ...z, departure: { ...z.departure, contract: { tour: tc, departure: { ...dc, services: [{ ...dc.services[0]!, included: true }] } } } },
  ];
  for (const v of variants) assert.notEqual(contractHash(v.offerRef, 'sha256:' + 'a'.repeat(64), sha256Hex(renderZayavka(v))), baseline);
});

test('application text is escaped, including departure program and supplier data', () => {
  const z = input();
  const injected = { ...z, departure: { ...z.departure, contract: { ...z.departure.contract,
    tour: { ...z.departure.contract.tour, risks: '<script>bad()</script>' } } } };
  const html = renderZayavka(injected);
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
});
