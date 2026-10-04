// The customer's pages and form posts. Deliberately plain: slice 3 replaces the markup with the
// site's booking page; the routes, cookies and checks here are what it keeps.
//
//   GET  /book?departure=<slug>      the booking form (contact, passengers, terms)
//   POST /orders                     reserve → state cookie → Refref attribution handoff
//   GET  /return?rt=&state=          the handoff's return: state checked, referral resolved
//   GET  /orders/<ref>               the order, read back from Refref first; the final price to accept
//   POST /orders/<ref>/pay           accept the final price → the provider's payment page
//
// Ownership of an order is the state secret in a __Host- cookie (HttpOnly, Secure, SameSite=Lax):
// another browser cannot see or pay someone's order, and a cross-site form cannot post with it.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { bookable } from './catalog.js';
import { handoffUrl, issueState, onReturn, ownsOrder, pay, reconcileOrder, type CheckoutDeps } from './checkout.js';
import { MAX_SEATS_PER_ORDER, reserve, type BookingRequest } from './orders.js';

const MAX_FORM_BYTES = 8 * 1024;
const COOKIE_PREFIX = '__Host-mk_';
const ORDER_REF = /^mk-[0-9a-z]{12}$/;

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const rub = (kopecks: number) => `${(kopecks / 100).toLocaleString('ru-RU')} ₽`;

const SECURITY_HEADERS = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'",
};

function page(res: ServerResponse, status: number, title: string, body: string, extraHead = ''): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${extraHead}<title>${esc(title)}</title></head><body><main style="max-width:40rem;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif">${body}</main></body></html>`);
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
  STATE_MISMATCH: 'Ссылка открыта не в том браузере, где начато бронирование.',
  REFREF_UNAVAILABLE: 'Платёжный сервис временно недоступен. Обновите страницу через минуту.',
  TERMS_NOT_ACCEPTED: 'Чтобы забронировать, примите условия бронирования.',
};
const message = (code: string) => MESSAGES[code] ?? `Не удалось продолжить бронирование (код ${esc(code)}).`;

export function createWebHandler(deps: CheckoutDeps, allowDemo: boolean) {
  async function bookForm(res: ServerResponse, slug: string) {
    const d = bookable(deps.catalog, slug, (deps.now ?? (() => new Date()))(), allowDemo);
    if (typeof d === 'string') { page(res, 404, 'Бронирование', `<p>${esc(message(d))}</p>`); return; }
    const t = deps.catalog.terms;
    const passengers = Array.from({ length: MAX_SEATS_PER_ORDER }, (_, i) => `<fieldset><legend>Участник ${i + 1}${i === 0 ? '' : ' (если едет)'}</legend>
      <label>ФИО <input name="passenger${i + 1}Name" ${i === 0 ? 'required' : ''} maxlength="200"></label>
      ${d.requiresDateOfBirth ? `<label>Дата рождения <input type="date" name="passenger${i + 1}Dob"></label>` : ''}</fieldset>`).join('');
    page(res, 200, `${d.tourTitle}: бронирование`, `<h1>${esc(d.tourTitle)}, ${esc(d.startsOn)} — ${esc(d.endsOn)}</h1>
      <p>Стоимость: ${rub(d.priceKopecks)} за участника, оплачивается полностью онлайн.</p>
      <form method="post" action="/orders">
        <input type="hidden" name="departure" value="${esc(d.slug)}">
        <input type="hidden" name="termsRef" value="${esc(t.ref)}"><input type="hidden" name="termsHash" value="${esc(t.hash)}">
        <fieldset><legend>Контакт для связи и чека</legend>
          <label>ФИО <input name="contactName" required maxlength="200"></label>
          <label>Телефон <input name="contactPhone" type="tel" required></label>
          <label>Email <input name="contactEmail" type="email" required></label></fieldset>
        ${passengers}
        <details><summary>Условия бронирования</summary><pre style="white-space:pre-wrap">${esc(t.text)}</pre></details>
        <label><input type="checkbox" name="adultsOnly" value="yes" required> Все участники старше 18 лет</label>
        <label><input type="checkbox" name="acceptTerms" value="yes" required> Принимаю условия бронирования</label>
        <button type="submit">Забронировать</button>
      </form>`);
  }

  async function createOrder(req: IncomingMessage, res: ServerResponse) {
    const form = await readForm(req);
    if (form === null || form.get('acceptTerms') !== 'yes') { page(res, 400, 'Бронирование', `<p>${message('TERMS_NOT_ACCEPTED')}</p>`); return; }
    const passengers: { fullName: string; dateOfBirth?: string }[] = [];
    for (let i = 1; i <= MAX_SEATS_PER_ORDER; i += 1) {
      const name = (form.get(`passenger${i}Name`) ?? '').trim();
      const dob = (form.get(`passenger${i}Dob`) ?? '').trim();
      if (name !== '') passengers.push({ fullName: name, ...(dob === '' ? {} : { dateOfBirth: dob }) });
    }
    const request: BookingRequest = {
      departureSlug: form.get('departure') ?? '',
      contact: { fullName: form.get('contactName') ?? '', phone: form.get('contactPhone') ?? '', email: form.get('contactEmail') ?? '' },
      passengers, adultsOnlyConfirmed: form.get('adultsOnly') === 'yes',
      termsRef: form.get('termsRef') ?? '', termsHash: form.get('termsHash') ?? '',
    };
    const r = await reserve({ pool: deps.pool, catalog: deps.catalog, log: deps.log, allowDemo, ...(deps.now ? { now: deps.now } : {}) }, request);
    if (!r.ok) { page(res, r.refusal === 'NOT_ENOUGH_SEATS' || r.refusal === 'SALES_CLOSED' ? 409 : 400, 'Бронирование', `<p>${esc(message(r.refusal))}</p>`); return; }
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
      discount_kopecks: string | null; last_session: string | null; seats: number }>(
      'SELECT status, payable_kopecks, amount_kopecks, discount_kopecks, last_session, seats FROM orders WHERE order_ref = $1', [ref]);
    const o = rows[0]!;
    const n = notice ? `<p>${esc(message(notice))}</p>` : '';
    if (o.status === 'RESERVED' && o.payable_kopecks !== null) {
      const discount = Number(o.discount_kopecks);
      page(res, 200, 'Подтверждение', `${n}<h1>Итого к оплате: ${rub(Number(o.payable_kopecks))}</h1>
        <p>Участников: ${o.seats}. Полная стоимость ${rub(Number(o.amount_kopecks))}${discount > 0 ? `, скидка по приглашению ${rub(discount)}` : ''}.</p>
        <form method="post" action="/orders/${esc(ref)}/pay"><button type="submit">Оплатить ${rub(Number(o.payable_kopecks))}</button></form>`);
    } else if (o.status === 'RESERVED') {
      // Not resolved yet (the handoff did not come back): go through it again, with this browser's state.
      page(res, 200, 'Бронирование', `${n}<p>Бронирование не завершено.</p>
        <p><a href="${esc(handoffUrl(deps.merchant, ref, state!))}">Продолжить</a></p>`);
    } else if (o.status === 'PAYMENT_PENDING' && (o.last_session ?? '').startsWith('PAYMENT_FAILED')) {
      page(res, 200, 'Оплата', `${n}<p>Платёж не прошёл. Деньги не списаны.</p>
        <form method="post" action="/orders/${esc(ref)}/pay"><button type="submit">Попробовать ещё раз</button></form>`);
    } else if (o.status === 'PAYMENT_PENDING') {
      page(res, 200, 'Оплата', `${n}<p>Проверяем платёж. Страница обновится сама.</p>`, '<meta http-equiv="refresh" content="5">');
    } else if (o.status === 'PAID' || o.status === 'FULFILLED') {
      page(res, 200, 'Бронирование подтверждено', `<h1>Бронирование подтверждено</h1><p>Номер заказа: ${esc(ref)}. Чек придёт на email.</p>`);
    } else if (o.status === 'HELD') {
      page(res, 200, 'Оплата', '<p>Проверяем платёж вручную. Мы свяжемся с вами. Повторно оплачивать не нужно.</p>');
    } else {
      page(res, 200, 'Бронирование', '<p>Бронирование не состоялось. Деньги не списаны.</p>');
    }
  }

  async function payRoute(req: IncomingMessage, res: ServerResponse, ref: string) {
    const state = cookies(req).get(`${COOKIE_PREFIX}${ref}`);
    if (!(await ownsOrder(deps.pool, ref, state))) { page(res, 404, 'Заказ', '<p>Заказ не найден.</p>'); return; }
    const r = await pay(deps, ref);
    if (r.kind === 'REDIRECT') { redirect(res, r.url); return; }
    redirect(res, r.code ? `/orders/${ref}?notice=${encodeURIComponent(r.code)}` : `/orders/${ref}`);
  }

  /** Returns false when the path is not one of these routes. */
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = /^\/orders\/([^/]+)(\/pay)?$/.exec(url.pathname);
    if (m && !ORDER_REF.test(m[1]!)) { page(res, 404, 'Заказ', '<p>Заказ не найден.</p>'); return true; }
    if (req.method === 'GET' && url.pathname === '/book') { await bookForm(res, url.searchParams.get('departure') ?? ''); return true; }
    if (req.method === 'POST' && url.pathname === '/orders') { await createOrder(req, res); return true; }
    if (req.method === 'GET' && url.pathname === '/return') { await back(req, res, url); return true; }
    if (req.method === 'GET' && m && !m[2]) {
      const notice = url.searchParams.get('notice');
      await show(req, res, m[1]!, notice !== null && /^[A-Z_]{1,40}$/.test(notice) ? notice : undefined);
      return true;
    }
    if (req.method === 'POST' && m && m[2]) { await payRoute(req, res, m[1]!); return true; }
    return false;
  };
}
