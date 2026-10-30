import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Bookable } from '../src/catalog.js';
import { issueState, onReturn, pay, zayavkaOf, type CheckoutDeps } from './retired/checkout.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { buildContractSnapshot, contractSnapshotHash } from '../src/contract-snapshot.js';
import { migrate } from '../src/migrate.js';
import { setSalesOpen } from '../src/orders.js';
import { RefrefClient } from './retired/refref.js';
import { buildSnapshot, snapshotDigest } from '../src/snapshot.js';
import { contractHash, sha256Hex } from '../src/zayavka.js';
import { FakeRefref } from './fake-refref.js';
import { fixtureCatalog, freshDb, seedCatalog, type TestDb } from './helpers.js';

test('schema-11 upgrade refuses legacy repricing and preserves the original pending payment window', async () => {
  const dir=mkdtempSync(join(tmpdir(),'commerce-checkout-upgrade-'));
  cpSync(MIGRATIONS_DIR,dir,{recursive:true});
  const journal=JSON.parse(readFileSync(join(dir,'journal.json'),'utf8'));
  writeFileSync(join(dir,'journal.json'),JSON.stringify(journal.filter((e:{version:number})=>e.version<=11)));
  for (const e of journal.filter((e:{version:number})=>e.version>11)) rmSync(join(dir,e.file));
  const lock=JSON.parse(readFileSync(join(dir,'migration.lock'),'utf8'));
  lock.migrations=lock.migrations.filter((e:{version:number})=>e.version<=11);
  writeFileSync(join(dir,'migration.lock'),JSON.stringify(lock));
  const fake=new FakeRefref('3f1c2a5e-8b4d-4c7e-9a10-2b6d8e4f1a90');
  let db: TestDb | undefined;
  try {
    db=await freshDb(dir); await fake.start();
    const clock=new Date();
    const catalog=fixtureCatalog([{slug:'upgrade-checkout',startsOn:'2027-07-01',endsOn:'2027-07-04'}]);
    await seedCatalog(db,catalog); await setSalesOpen(db.operator,true,'test','upgrade');
    const departure=catalog.departures.get('upgrade-checkout') as Bookable;
    const contract=buildContractSnapshot(departure,catalog.timezone);
    const ref='mk-123456789abc';
    const inserted=await db.owner.query(`INSERT INTO orders(order_ref,departure_slug,trip_starts_on,trip_ends_on,seats,
      unit_price_kopecks,amount_kopecks,status,reserved_until,legal_release_ref,legal_release_hash,legal_release_content,
      pd_consent_ref,pd_consent_hash,pd_consent_content,pd_consent_accepted_at,adults_only_confirmed,created_at,
      trip_departure_time,trip_return_time,trip_timezone,contract_snapshot,contract_snapshot_sha256,
      referral_resolution_id,resolution_expires_at,discount_kopecks,payable_kopecks)
      VALUES ($1,$2,$3,$4,1,$5,$5,'RESERVED',$6,$7,$8,$9,$10,$11,$12,$13,true,$13,'06:00','21:00',$14,$15,$16,
        '7a0e1c3b-5d2f-4e8a-b6c1-9f3d2e4a5b60',$6,0,$5) RETURNING id`,
      [ref,departure.slug,departure.startsOn,departure.endsOn,departure.priceKopecks,new Date(clock.getTime()+30*60_000),
        catalog.terms.ref,catalog.terms.hash,catalog.terms.text,catalog.pdConsent.ref,catalog.pdConsent.hash,catalog.pdConsent.text,
        clock,catalog.timezone,contract,contractSnapshotHash(contract)]);
    const content='<article>Legacy application: 34 000 RUB, no referral discount</article>';
    await db.owner.query("INSERT INTO order_document(order_id,kind,content,sha256,created_at) VALUES ($1,'ZAYAVKA',$2,$3,$4)",
      [inserted.rows[0].id,content,sha256Hex(content),clock]);
    const state=(await issueState(db.pool,ref))!;
    // Seed an actual PAYMENT_PENDING row at schema 11, alongside the legacy RESERVED case.
    const pendingRef='mk-123456789abd';
    const pending=(await db.owner.query(`INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,
      to_jsonb(o)||jsonb_build_object('id',gen_random_uuid(),'order_ref',$2::text,'state_hash',NULL))).*
      FROM orders o WHERE o.id=$1 RETURNING id`,[inserted.rows[0].id,pendingRef])).rows[0];
    await db.owner.query("INSERT INTO order_document(order_id,kind,content,sha256,created_at) VALUES ($1,'ZAYAVKA',$2,$3,$4)",
      [pending.id,content,sha256Hex(content),clock]);
    await db.owner.query('INSERT INTO order_contact(order_id,full_name,phone,email) VALUES ($1,$2,$3,$4)',
      [pending.id,'Иван Петров','+79039075547','test@example.ru']);
    const snapshot=buildSnapshot({orderRef:pendingRef,tourSlug:departure.tourSlug,tourTitle:departure.tourTitle,
      departureSlug:departure.slug,startsOn:departure.startsOn,endsOn:departure.endsOn,startsTime:'06:00',endsTime:'21:00',
      timezone:catalog.timezone,seats:1,amountKopecks:departure.priceKopecks},
      {merchantId:fake.merchantId,referralResolutionId:'7a0e1c3b-5d2f-4e8a-b6c1-9f3d2e4a5b60',termsVersionId:null,discountKopecks:0},
      {ref:catalog.terms.ref,hash:contractHash(catalog.terms.ref,catalog.terms.hash,sha256Hex(content))});
    const hash=snapshotDigest(snapshot);
    const api=new RefrefClient({apiBase:fake.base,apiKey:'test',timeoutMs:500});
    const created=await api.createAttempt(pendingRef,{referralResolutionId:'7a0e1c3b-5d2f-4e8a-b6c1-9f3d2e4a5b60',snapshot,snapshotHash:hash},`mk-attempt:${pendingRef}`);
    assert.ok(created.kind==='ANSWERED'&&created.status===201);
    await db.owner.query(`UPDATE orders SET status='PAYMENT_PENDING',snapshot=$2,snapshot_hash=$3,payment_pending_since=$4,
      checkout_attempt_id=$5 WHERE order_ref=$1`,[pendingRef,snapshot,hash,clock,created.body.checkoutAttemptId]);

    const unsentRef='mk-123456789abe';
    const unsentResolution='7a0e1c3b-5d2f-4e8a-b6c1-9f3d2e4a5b61';
    const unsentSnapshot={...snapshot,merchantOrderRef:unsentRef,referralResolutionId:unsentResolution,
      paymentPurpose:`Оплата туристского продукта по заявке ${unsentRef}`};
    const unsent=(await db.owner.query(`INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,
      to_jsonb(o)||jsonb_build_object('id',gen_random_uuid(),'order_ref',$2::text,'checkout_attempt_id',NULL,
        'referral_resolution_id',$3::text,'snapshot',$4::jsonb,'snapshot_hash',$5::text))).*
      FROM orders o WHERE o.id=$1 RETURNING id`,[pending.id,unsentRef,unsentResolution,JSON.stringify(unsentSnapshot),snapshotDigest(unsentSnapshot)])).rows[0];
    await db.owner.query("INSERT INTO order_document(order_id,kind,content,sha256,created_at) VALUES ($1,'ZAYAVKA',$2,$3,$4)",
      [unsent.id,content,sha256Hex(content),clock]);
    await db.owner.query('INSERT INTO order_contact(order_id,full_name,phone,email) VALUES ($1,$2,$3,$4)',
      [unsent.id,'Иван Петров','+79039075547','test@example.ru']);
    const history=(await db.owner.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
    await migrate(db.owner,MIGRATIONS_DIR);
    assert.deepEqual((await db.owner.query('SELECT version,checksum FROM schema_migrations WHERE version<=11 ORDER BY version')).rows,history);
    const deps:CheckoutDeps={pool:db.pool,catalog,now:()=>clock,log:()=>undefined,
      refref:new RefrefClient({apiBase:fake.base,apiKey:'test',timeoutMs:500}),
      merchant:{businessId:fake.merchantId,businessSlug:'mikluha',checkoutOrigin:'https://checkout.example',origin:'https://book.example',siteOrigin:'https://site.example'}};
    fake.state.discountKopecks=100_000;
    const priorRequests=fake.requests.length;
    assert.deepEqual(await onReturn(deps,{rt:'t'.repeat(40),state,cookieState:()=>state}),
      {kind:'REFUSED',code:'QUOTE_REQUIRES_REBOOK',orderRef:ref});
    assert.deepEqual(await pay(deps,ref,sha256Hex(content)),{kind:'STATUS',code:'QUOTE_REQUIRES_REBOOK'});
    assert.deepEqual(await zayavkaOf(db.pool,ref),{content,sha256:sha256Hex(content)});
    const current=(await db.owner.query('SELECT quote_issued_at,discount_kopecks,payable_kopecks,attempt_creation_state FROM orders WHERE order_ref=$1',[ref])).rows[0];
    assert.deepEqual(current,{quote_issued_at:null,discount_kopecks:'0',payable_kopecks:'3400000',attempt_creation_state:'UNKNOWN'});
    assert.equal(fake.requests.length,priorRequests);
    clock.setTime(clock.getTime()+20*60_000);
    fake.state.session='FAILED';
    assert.equal((await pay(deps,pendingRef,sha256Hex(content))).kind,'STATUS');
    fake.state.session='READY';
    await db.owner.query("UPDATE departure SET booking_status='CLOSED' WHERE slug='upgrade-checkout'");
    assert.equal((await pay(deps,pendingRef,sha256Hex(content))).kind,'REDIRECT');
    assert.equal(fake.calls(/checkout-attempts$/).length,1);
    assert.equal((await db.owner.query('SELECT quote_issued_at FROM orders WHERE order_ref=$1',[pendingRef])).rows[0].quote_issued_at,null);
    assert.equal((await pay(deps,unsentRef,sha256Hex(content))).kind,'REDIRECT');
    assert.equal(fake.calls(/checkout-attempts$/).length,2);
    const sent=JSON.parse(fake.attempts.get(unsentRef)!.body);
    assert.equal(sent.snapshotHash,snapshotDigest(unsentSnapshot));
    assert.equal(sent.snapshot.totalContractAmountKopecks,3400000);
    assert.equal(fake.calls(/referral-resolutions/).length,0);
    clock.setTime(clock.getTime()+11*60_000);
    assert.deepEqual(await pay(deps,pendingRef,sha256Hex(content)),{kind:'STATUS',code:'RESERVATION_EXPIRED'});

  } finally {
    await fake.stop(); await db?.drop(); rmSync(dir,{recursive:true,force:true});
  }
});
