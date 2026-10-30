import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createRetiredCheckoutHandler } from '../src/retired-checkout.js';

test('legacy checkout methods return 410 without cookies, reflection or redirects', async () => {
  const handle = createRetiredCheckoutHandler('https://mikluha-maklai.ru');
  const server = createServer((req, res) => {
    void handle(req, res, new URL(req.url!, 'http://localhost')).then(claimed => {
      if (!claimed) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      for (const path of ['/book?departure=old', '/orders', '/orders/old/pay', '/return?rt=secret', '/arrive?arrival=secret&to=https://attacker.invalid', '/documents/secret']) {
        const res = await fetch(base + path, { method, redirect: 'manual', headers: { cookie: 'old=secret' } });
        assert.equal(res.status, 410, `${method} ${path}`);
        assert.equal(res.headers.get('set-cookie'), null);
        assert.equal(res.headers.get('location'), null);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const html = await res.text();
        assert.match(html, /Онлайн-бронирование закрыто/);
        assert.doesNotMatch(html, /secret|attacker|<form|refref/i);
      }
    }
    assert.equal((await fetch(base + '/public/v1/catalog')).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
