// The retired Refref transport has no production handler or worker. Native checkout is
// qualified separately (TOUR-77/78); no legacy URL may reserve seats or initiate payment.
import type { RouteHandler } from './server.js';

export function createRetiredCheckoutHandler(siteOrigin: string): RouteHandler {
  return async (_req, res, url) => {
    if (!/^\/(?:book|orders|return|arrive|documents)(?:\/|$)/.test(url.pathname)) return false;
    res.writeHead(410, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'x-robots-tag': 'noindex', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    const site = new URL(siteOrigin).origin;
    res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Онлайн-бронирование закрыто</title><h1>Онлайн-бронирование закрыто</h1><p>Свяжитесь с организатором для уточнения информации.</p><a href="${site}/#contacts">Контакты организатора</a></html>`);
    return true;
  };
}
