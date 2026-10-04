// The customer's pages and form posts, using the public site's visual language.
//
//   GET  /book?departure=<slug>      the booking form (contact, passengers, terms)
//   POST /orders                     reserve → state cookie → Refref attribution handoff
//   GET  /return?rt=&state=          the handoff's return: state checked, referral resolved
//   GET  /orders/<ref>               the order, read back from Refref first; the final price to accept
//   POST /orders/<ref>/pay           accept the final price → the provider's payment page
//
// Ownership of an order is the state secret in a __Host- cookie (HttpOnly, Secure, SameSite=Lax):
// another browser cannot see or pay someone's order, and a cross-site form cannot post with it.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { bookable } from './catalog.js';
import { handoffUrl, issueState, onReturn, ownsOrder, pay, reconcileOrder, zayavkaOf, type CheckoutDeps } from './checkout.js';
import { countryName, MAX_SEATS_PER_ORDER, reserve, type BookingRequest, type TouristInput } from './orders.js';
import { BookingRateLimiter } from './rate-limit.js';

/** Citizenships offered in the form, Russia first. Any country code is accepted by the service. */
const CITIZENSHIPS = ['RU', 'BY', 'KZ', 'KG', 'AM', 'AZ', 'UZ', 'TJ', 'TM', 'MD', 'GE', 'MN', 'CN'];

const MAX_FORM_BYTES = 8 * 1024;
const COOKIE_PREFIX = '__Host-mk_';
const ORDER_REF = /^mk-[0-9a-z]{12}$/;
const DOCUMENT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const rub = (kopecks: number) => `${(kopecks / 100).toLocaleString('ru-RU')} ₽`;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const SECURITY_HEADERS = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'",
};

const STYLES = `<style>
:root{color-scheme:light;--paper:#fcfaf4;--ink:#332b26;--muted:#74675d;--line:#e6dbce;--card:#fff;--rust:#bd623c;--rust-dark:#914426;--blue:#225f78;--green:#dcebdd;--focus:#d28158}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}
a{color:var(--blue);text-underline-offset:3px}a:hover{color:var(--rust-dark)}header{border-bottom:1px solid var(--line);background:#fff9}
.bar{max-width:72rem;margin:auto;padding:1rem clamp(1rem,4vw,2rem);display:flex;align-items:center;justify-content:space-between}.brand{color:var(--ink);font-weight:700;font-size:1.25rem;text-decoration:none}.secure{color:var(--muted);font-size:.82rem}
main{max-width:56rem;margin:clamp(1.5rem,5vw,4rem) auto;padding:0 clamp(1rem,4vw,2rem) 5rem}.eyebrow{color:var(--rust-dark);font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1,h2,h3,legend{font-family:inherit;line-height:1.16;font-weight:650}h1{font-size:clamp(2rem,6vw,3.6rem);margin:.3rem 0 1rem}h2{font-size:1.5rem}.lead{font-size:1.08rem;color:var(--muted);max-width:46rem}.summary{background:var(--green);border:1px solid #c5dcc8;border-radius:1.25rem;padding:1.1rem 1.25rem;margin:1.5rem 0 2rem}.summary strong{color:#234f35}
form{display:grid;gap:1rem}fieldset,.card,.contract-doc{border:1px solid var(--line);border-radius:1.25rem;background:var(--card);padding:clamp(1rem,3vw,1.5rem);box-shadow:0 8px 24px #59351d0a}fieldset{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:0}legend{padding:0 .5rem;font-size:1.15rem;font-weight:700}label{display:grid;gap:.4rem;font-weight:650;font-size:.92rem}label:has(input[type=checkbox]){display:grid;grid-template-columns:auto 1fr;align-items:start;font-weight:500;padding:.7rem 0}input,select{width:100%;border:1px solid #cfc1b3;border-radius:.7rem;background:#fff;padding:.75rem .8rem;color:var(--ink);font:inherit}input[type=checkbox]{width:1.15rem;height:1.15rem;margin:.2rem 0 0;accent-color:var(--rust)}input:focus,select:focus,button:focus,a:focus{outline:3px solid color-mix(in srgb,var(--focus) 45%,transparent);outline-offset:2px}
button,.button{appearance:none;border:0;border-radius:999px;background:var(--rust);color:#fff;padding:.85rem 1.35rem;font:700 1rem inherit;cursor:pointer;text-decoration:none;justify-self:start}button:hover,.button:hover{background:var(--rust-dark);color:#fff}.notice{border-left:4px solid var(--rust);background:#fff1e9;padding:.9rem 1rem;border-radius:.25rem .8rem .8rem .25rem}.contract-doc{margin:1.25rem 0}.contract-doc summary{cursor:pointer;font-size:1.15rem;font-weight:700}.contract-doc pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.6}.document-frame{overflow:auto}.document-frame table{width:100%;border-collapse:collapse}.document-frame th,.document-frame td{border:1px solid var(--line);padding:.55rem;text-align:left;vertical-align:top}
.steps{display:flex;gap:.5rem;margin:0 0 1.5rem;padding:0;list-style:none}.steps li{flex:1;border-top:3px solid var(--line);padding-top:.45rem;color:var(--muted);font-size:.78rem}.steps .current{border-color:var(--rust);color:var(--ink);font-weight:700}.meta{color:var(--muted);font-size:.88rem}
@media(max-width:640px){fieldset{grid-template-columns:1fr}.secure{display:none}main{margin-top:1.5rem}.steps li{font-size:.7rem}}
</style>`;

function page(res: ServerResponse, status: number, title: string, body: string, extraHead = '', headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...headers });
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${extraHead}${STYLES}<title>${esc(title)}</title></head><body><header><div class="bar"><a class="brand" href="/">Миклуха</a><span class="secure">Защищённое бронирование</span></div></header><main>${body}</main></body></html>`);
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.writeHead(303, { location, ...SECURITY_HEADERS, ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  res.end();
}

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

const stateCookie = (orderRef: string, state: string) =>
  `${COOKIE_PREFIX}${orderRef}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`;

function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) { resolve(null); return; }
    let raw = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', (c: string) => { bytes += Buffer.byteLength(c); if (bytes <= MAX_FORM_BYTES) raw += c; });
    req.on('end', () => resolve(bytes > MAX_FORM_BYTES ? null : new URLSearchParams(raw)));
    req.on('error', reject);
  });
}

/** Customer-facing words for the codes the flow returns. Codes never carry personal data. */
const MESSAGES: Record<string, string> = {
  SALES_CLOSED: 'Онлайн-бронирование сейчас приостановлено. Попробуйте позже или свяжитесь с организатором.',
  NOT_ENOUGH_SEATS: 'Свободных мест на эту дату не осталось.',
  RESERVATION_EXPIRED: 'Время брони истекло. Начните бронирование заново.',
  TERMS_NOT_CURRENT: 'Условия бронирования обновились. Откройте форму заново.',
  PD_CONSENT_NOT_CURRENT: 'Согласие на обработку персональных данных обновилось. Откройте форму заново.',
  PD_CONSENT_NOT_CONFIRMED: 'Для онлайн-бронирования нужно отдельно подтвердить согласие на обработку персональных данных.',
  PD_CONSENT_INVALID: 'Сохранённое подтверждение согласия не прошло проверку. Начните бронирование заново.',
  STATE_MISMATCH: 'Ссылка открыта не в том браузере, где начато бронирование.',
  REFREF_UNAVAILABLE: 'Платёжный сервис временно недоступен. Обновите страницу через минуту.',
  FORM_INVALID: 'Форма заполнена неверно. Откройте её заново.',
  RATE_LIMITED: 'Слишком много попыток бронирования. Подождите и попробуйте снова.',
  LEGAL_RELEASE_INVALID: 'Сохранённая редакция Оферты не прошла проверку. Начните бронирование заново.',
  LEGAL_RELEASE_NOT_ADMITTED: 'Публикация условий обновляется. Онлайн-бронирование временно приостановлено.',
  DOCUMENT_CHANGED: 'Заявка изменилась после того, как вы её открыли. Проверьте её ещё раз.',
  DEPARTURE_NO_CONTRACT: 'Онлайн-бронирование этого выезда пока недоступно. Свяжитесь с организатором.',
  DOCUMENT_INVALID: 'Проверьте документ туриста: для паспорта РФ — серия 4 цифры и номер 6 цифр, для загранпаспорта РФ — 2 и 7 цифр.',
  CITIZENSHIP_INVALID: 'Выберите гражданство туриста.',
  DATE_OF_BIRTH_INVALID: 'Проверьте даты рождения туристов.',
  PASSENGER_NOT_ADULT: 'Онлайн-бронирование доступно только для совершеннолетних туристов. Для поездки с детьми свяжитесь с организатором.',
};
const message = (code: string) => MESSAGES[code] ?? `Не удалось продолжить бронирование (код ${esc(code)}).`;

export function createWebHandler(deps: CheckoutDeps, allowDemo: boolean, limiter = new BookingRateLimiter()) {
  async function bookForm(res: ServerResponse, slug: string) {
    const d = bookable(deps.catalog, slug, (deps.now ?? (() => new Date()))(), allowDemo);
    if (typeof d === 'string') { page(res, 404, 'Бронирование', `<p>${esc(message(d))}</p>`); return; }
    const t = deps.catalog.terms;
    const consent = deps.catalog.pdConsent;
    const site = deps.merchant.siteOrigin;
    const countries = CITIZENSHIPS.map((c) => `<option value="${c}">${esc(countryName(c) ?? c)}</option>`).join('');
    const tourists = Array.from({ length: MAX_SEATS_PER_ORDER }, (_, i) => {
      const k = `t${i + 1}`;
      const req = i === 0 ? 'required' : '';
      return `<fieldset><legend>Турист ${i + 1}${i === 0 ? ' — Заказчик (вы)' : ' (если едет)'}</legend>
      <label>ФИО <input name="${k}Name" ${req} maxlength="200" autocomplete="off"></label>
      <label>Дата рождения <input type="date" name="${k}Dob" ${req}></label>
      <label>Гражданство <select name="${k}Citizenship">${countries}</select></label>
      <label>Документ <select name="${k}DocType">
        <option value="RU_PASSPORT">Паспорт гражданина РФ</option>
        <option value="RU_INTERNATIONAL_PASSPORT">Заграничный паспорт гражданина РФ</option>
        <option value="FOREIGN_DOCUMENT">Документ иностранного гражданина</option></select></label>
      <label>Серия <input name="${k}DocSeries" maxlength="10" autocomplete="off"></label>
      <label>Номер <input name="${k}DocNumber" ${req} maxlength="20" autocomplete="off"></label></fieldset>`;
    }).join('');
    page(res, 200, `${d.tourTitle}: бронирование`, `<p class="eyebrow">Онлайн-бронирование</p><h1>${esc(d.tourTitle)}</h1>
      <p class="lead">${esc(d.startsOn)} — ${esc(d.endsOn)}. Заполните данные участников, затем проверьте итоговую Заявку перед оплатой.</p>
      <ol class="steps"><li class="current">1. Данные</li><li>2. Заявка</li><li>3. Оплата</li></ol>
      <div class="summary"><strong>${rub(d.priceKopecks)} за туриста</strong><br>100% оплата онлайн · места резервируются на 30 минут</div>
      <form method="post" action="/orders">
        <input type="hidden" name="departure" value="${esc(d.slug)}">
        <input type="hidden" name="termsRef" value="${esc(t.ref)}"><input type="hidden" name="termsHash" value="${esc(t.hash)}">
        <input type="hidden" name="pdConsentRef" value="${esc(consent.ref)}"><input type="hidden" name="pdConsentHash" value="${esc(consent.hash)}">
        <p>Заказчик — турист № 1: бронировать онлайн можно поездку, в которой вы участвуете сами.</p>
        ${tourists}
        <fieldset><legend>Контакты Заказчика: для связи и чека</legend>
          <label>Телефон <input name="contactPhone" type="tel" required></label>
          <label>Email <input name="contactEmail" type="email" required></label></fieldset>
        <p>Данные туристов нужны для заключения и исполнения договора и передачи сведений в ЕИС «Электронная путёвка», как того требует закон.
          Подробнее — в <a href="${esc(site)}/privacy-policy">Политике обработки персональных данных</a>.</p>
        <label><input type="checkbox" name="pdConsent" value="yes" required> Я отдельно даю
          <a href="${esc(site)}/soglasie-pd">согласие на обработку персональных данных</a> в опубликованной редакции.</label>
        <label><input type="checkbox" name="adultsOnly" value="yes" required> Все туристы совершеннолетние</label>
        <p>Перед оплатой вы увидите Заявку на бронирование с итоговой ценой. Договор заключается на условиях
          <a href="${esc(site)}/oferta">Публичной оферты</a> в момент оплаты.</p>
        <button type="submit">Перейти к проверке заявки</button>
      </form>`);
  }

  async function createOrder(req: IncomingMessage, res: ServerResponse) {
    const at = (deps.now ?? (() => new Date()))().getTime();
    const ip = limiter.checkIp(req.headers, at);
    if (!ip.allowed) { page(res, 429, 'Бронирование', `<p class="notice">${message('RATE_LIMITED')}</p>`, '',
      { 'retry-after': String(ip.retryAfterSeconds) }); return; }
    const form = await readForm(req);
    if (form === null) { page(res, 400, 'Бронирование', `<p>${message('FORM_INVALID')}</p>`); return; }
    const tourists: TouristInput[] = [];
    for (let i = 1; i <= MAX_SEATS_PER_ORDER; i += 1) {
      const f = (k: string) => (form.get(`t${i}${k}`) ?? '').trim();
      if (f('Name') === '') continue;
      tourists.push({ fullName: f('Name'), dateOfBirth: f('Dob'), citizenship: f('Citizenship'),
        document: { type: f('DocType'), series: f('DocSeries'), number: f('DocNumber') } });
    }
    const request: BookingRequest = {
      departureSlug: form.get('departure') ?? '',
      contact: { phone: form.get('contactPhone') ?? '', email: form.get('contactEmail') ?? '' },
      passengers: tourists, adultsOnlyConfirmed: form.get('adultsOnly') === 'yes',
      termsRef: form.get('termsRef') ?? '', termsHash: form.get('termsHash') ?? '',
      pdConsentConfirmed: form.get('pdConsent') === 'yes',
      pdConsentRef: form.get('pdConsentRef') ?? '', pdConsentHash: form.get('pdConsentHash') ?? '',
    };
    const email = limiter.checkEmail(request.contact.email, at);
    if (!email.allowed) { page(res, 429, 'Бронирование', `<p class="notice">${message('RATE_LIMITED')}</p>`, '',
      { 'retry-after': String(email.retryAfterSeconds) }); return; }
    const r = await reserve({ pool: deps.pool, catalog: deps.catalog, log: deps.log, allowDemo,
      ...(deps.legalAdmission ? { legalAdmission: deps.legalAdmission } : {}), ...(deps.now ? { now: deps.now } : {}) }, request);
    if (!r.ok) { page(res, ['NOT_ENOUGH_SEATS', 'SALES_CLOSED', 'LEGAL_RELEASE_NOT_ADMITTED'].includes(r.refusal) ? 409 : 400,
      'Бронирование', `<p>${esc(message(r.refusal))}</p>`); return; }
    const state = await issueState(deps.pool, r.orderRef);
    if (state === null) throw new Error('STATE_NOT_ISSUED');
    redirect(res, handoffUrl(deps.merchant, r.orderRef, state), [stateCookie(r.orderRef, state)]);
  }

  async function back(req: IncomingMessage, res: ServerResponse, url: URL) {
    const jar = cookies(req);
    const outcome = await onReturn(deps, { rt: url.searchParams.get('rt'), state: url.searchParams.get('state'),
      cookieState: (ref) => jar.get(`${COOKIE_PREFIX}${ref}`) });
    if (outcome.kind === 'REDIRECT') { redirect(res, outcome.url); return; }
    if (outcome.kind === 'CONFIRM') { redirect(res, `/orders/${outcome.orderRef}`); return; }
    page(res, outcome.code === 'STATE_MISMATCH' ? 403 : 409, 'Бронирование', `<p>${esc(message(outcome.code))}</p>`);
  }

  async function show(req: IncomingMessage, res: ServerResponse, ref: string, notice?: string) {
    const state = cookies(req).get(`${COOKIE_PREFIX}${ref}`);
    if (!(await ownsOrder(deps.pool, ref, state))) { page(res, 404, 'Заказ', '<p>Заказ не найден.</p>'); return; }
    // The page shows what Refref says now, never what the browser's return claims.
    await reconcileOrder(deps, ref);
    const { rows } = await deps.pool.query<{ status: string; payable_kopecks: string | null; amount_kopecks: string;
      discount_kopecks: string | null; last_session: string | null; seats: number; legal_release_ref: string;
      legal_release_content: string | null; pd_consent_ref: string }>(
      `SELECT status, payable_kopecks, amount_kopecks, discount_kopecks, last_session, seats,
        legal_release_ref, legal_release_content, pd_consent_ref FROM orders WHERE order_ref = $1`, [ref]);
    const o = rows[0]!;
    const n = notice ? `<p class="notice">${esc(message(notice))}</p>` : '';
    const zayavka = await zayavkaOf(deps.pool, ref);
    const accept = `<input type="hidden" name="zayavka" value="${esc(zayavka?.sha256 ?? '')}">`;
    const site = deps.merchant.siteOrigin;
    const offer = o.legal_release_content === null ? '' : `<details class="contract-doc" open><summary>Публичная оферта · ${esc(o.legal_release_ref)}</summary><pre>${esc(o.legal_release_content)}</pre></details>`;
    const documents = `${offer}${zayavka?.content ? `<section class="contract-doc document-frame"><h2>Заявка на бронирование</h2>${zayavka.content}</section>` : ''}`;
    if (o.status === 'RESERVED' && o.payable_kopecks !== null && zayavka?.content) {
      const discount = Number(o.discount_kopecks);
      // The Заявка exactly as stored; paying accepts it and the offer (offer §4.2, Заявка §9).
      page(res, 200, 'Заявка на бронирование', `${n}<p class="eyebrow">Проверьте договор</p><h1>Итого к оплате: ${rub(Number(o.payable_kopecks))}</h1>
        <ol class="steps"><li>1. Данные</li><li class="current">2. Заявка</li><li>3. Оплата</li></ol>
        <p>Туристов: ${o.seats}. Полная стоимость ${rub(Number(o.amount_kopecks))}${discount > 0 ? `, скидка по приглашению ${rub(discount)}` : ''}.</p>
        <p>Проверьте Заявку: ФИО, даты рождения, гражданство и документы туристов передаются перевозчику, в средство размещения и в ЕИС «Электронная путёвка».</p>
        ${documents}
        <p>Документы: <a href="${esc(site)}/oferta">Публичная оферта</a> · <a href="${esc(site)}/turoperator">Сведения о туроператоре</a> ·
          <a href="${esc(site)}/pravila-oplaty">Правила оплаты</a> · <a href="${esc(site)}/otkaz-i-vozvrat">Правила отказа и возврата</a>.</p>
        <form method="post" action="/orders/${esc(ref)}/pay">${accept}
          <p>Оплачивая заказ, я подтверждаю, что ознакомился(ась) с Публичной офертой, Заявкой на бронирование № ${esc(ref)} и Программой тура и согласен(на) с их условиями.</p>
          <button type="submit">Оплатить ${rub(Number(o.payable_kopecks))}</button></form>`);
    } else if (o.status === 'RESERVED') {
      // Not resolved yet (the handoff did not come back): go through it again, with this browser's state.
      page(res, 200, 'Бронирование', `${n}<p>Бронирование не завершено.</p>
        <p><a href="${esc(handoffUrl(deps.merchant, ref, state!))}">Продолжить</a></p>`);
    } else if (o.status === 'PAYMENT_PENDING' && (o.last_session ?? '').startsWith('PAYMENT_FAILED')) {
      page(res, 200, 'Оплата', `${n}<p>Платёж не прошёл. Деньги не списаны.</p>
        <form method="post" action="/orders/${esc(ref)}/pay">${accept}<button type="submit">Попробовать ещё раз</button></form>`);
    } else if (o.status === 'PAYMENT_PENDING') {
      page(res, 200, 'Оплата', `${n}<p>Проверяем платёж. Страница обновится сама.</p>`, '<meta http-equiv="refresh" content="5">');
    } else if (o.status === 'PAID' || o.status === 'FULFILLED') {
      page(res, 200, 'Бронирование подтверждено', `<p class="eyebrow">Готово</p><h1>Бронирование подтверждено</h1>
        <div class="summary"><strong>Номер заказа: ${esc(ref)}</strong><br>Чек и подтверждение придут на email. Билеты и ваучеры — не позднее чем за 24 часа до поездки.</div>
        <p class="meta">Ниже сохранены редакции документов, с которыми оформлен заказ. Согласие на обработку персональных данных: ${esc(o.pd_consent_ref)}.</p>${documents}`);
    } else if (o.status === 'HELD') {
      page(res, 200, 'Оплата', '<p>Проверяем платёж вручную. Мы свяжемся с вами. Повторно оплачивать не нужно.</p>');
    } else {
      page(res, 200, 'Бронирование', '<p>Бронирование не состоялось. Деньги не списаны.</p>');
    }
  }

  async function sharedDocuments(res: ServerResponse, token: string) {
    if (!DOCUMENT_TOKEN.test(token)) { page(res, 404, 'Документы заказа', '<p>Ссылка недействительна.</p>'); return; }
    const { rows } = await deps.pool.query<{ order_ref: string; legal_release_ref: string; legal_release_content: string | null;
      pd_consent_ref: string; content: string | null }>(`SELECT o.order_ref, o.legal_release_ref, o.legal_release_content,
        o.pd_consent_ref, d.content FROM orders o JOIN order_document d ON d.order_id = o.id AND d.kind = 'ZAYAVKA'
        WHERE o.document_access_hash = $1 AND o.status IN ('PAID','FULFILLED','REFUNDED')`, [sha256(token)]);
    const row = rows[0];
    if (row === undefined || row.content === null || row.legal_release_content === null) {
      page(res, 404, 'Документы заказа', '<p>Документы по этой ссылке недоступны.</p>'); return;
    }
    page(res, 200, 'Документы заказа', `<p class="eyebrow">Сохранённые документы</p><h1>Заказ ${esc(row.order_ref)}</h1>
      <p class="notice">Эта ссылка открывает договорные документы заказа. Не пересылайте её другим людям.</p>
      <p class="meta">Согласие на обработку персональных данных: ${esc(row.pd_consent_ref)}.</p>
      <details class="contract-doc" open><summary>Публичная оферта · ${esc(row.legal_release_ref)}</summary><pre>${esc(row.legal_release_content)}</pre></details>
      <section class="contract-doc document-frame"><h2>Заявка на бронирование</h2>${row.content}</section>`);
  }

  async function payRoute(req: IncomingMessage, res: ServerResponse, ref: string) {
    const state = cookies(req).get(`${COOKIE_PREFIX}${ref}`);
    if (!(await ownsOrder(deps.pool, ref, state))) { page(res, 404, 'Заказ', '<p>Заказ не найден.</p>'); return; }
    const form = await readForm(req);
    const r = await pay(deps, ref, form?.get('zayavka') ?? '');
    if (r.kind === 'REDIRECT') { redirect(res, r.url); return; }
    redirect(res, r.code ? `/orders/${ref}?notice=${encodeURIComponent(r.code)}` : `/orders/${ref}`);
  }

  /** Returns false when the path is not one of these routes. */
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = /^\/orders\/([^/]+)(\/pay)?$/.exec(url.pathname);
    const shared = /^\/documents\/([^/]+)$/.exec(url.pathname);
    if (m && !ORDER_REF.test(m[1]!)) { page(res, 404, 'Заказ', '<p>Заказ не найден.</p>'); return true; }
    if (req.method === 'GET' && url.pathname === '/book') { await bookForm(res, url.searchParams.get('departure') ?? ''); return true; }
    if (req.method === 'POST' && url.pathname === '/orders') { await createOrder(req, res); return true; }
    if (req.method === 'GET' && url.pathname === '/return') { await back(req, res, url); return true; }
    if (req.method === 'GET' && shared) { await sharedDocuments(res, shared[1]!); return true; }
    if (req.method === 'GET' && m && !m[2]) {
      const notice = url.searchParams.get('notice');
      await show(req, res, m[1]!, notice !== null && /^[A-Z_]{1,40}$/.test(notice) ? notice : undefined);
      return true;
    }
    if (req.method === 'POST' && m && m[2]) { await payRoute(req, res, m[1]!); return true; }
    return false;
  };
}
