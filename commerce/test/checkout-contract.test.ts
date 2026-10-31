// ART-362: real PostgreSQL/runtime roles, immutable contracts and merchant-held seats.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import pg from 'pg';

import { issueState, onReturn, pay, reconcileAll, zayavkaOf, type CheckoutDeps } from './retired/checkout.js';
import { maintain, reserve, setSalesOpen } from '../src/orders.js';
import { RefrefClient } from './retired/refref.js';
import { FakeRefref } from './fake-refref.js';
import { captureLog, fixtureCatalog, freshDb, seedCatalog, tourist, type TestDb, resetOrders } from './helpers.js';

let db: TestDb;
let fake: FakeRefref;
let deps: CheckoutDeps;
let audit:ReturnType<typeof captureLog>;
let clock: Date;
let slug: string;
let sequence = 0;
const start = new Date();
const minute = 60_000;
// Non-cutoff scenarios must stay bookable when CI runs after the old demo date.
const startsOn = new Date(start.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
const endsOn = new Date(start.getTime() + 17 * 86_400_000).toISOString().slice(0, 10);
before(async () => {
  db = await freshDb();
  fake = new FakeRefref('3f1c2a5e-8b4d-4c7e-9a10-2b6d8e4f1a90');
  await fake.start();
});
after(async () => { await fake.stop(); await db.drop(); });
beforeEach(async () => {
  await resetOrders(db.owner);
  fake.reset(); clock = new Date(start); slug = `contract-${++sequence}`;
  const catalog = fixtureCatalog([{ slug, startsOn, endsOn, capacity: 2 }]);
  await seedCatalog(db, catalog);
  await setSalesOpen(db.operator, true, 'test', 'isolated checkout');
  audit=captureLog();
  deps = { pool: db.pool, initiationPool: db.initiation, catalog, log: audit.log, now: () => clock,
    refref: new RefrefClient({ apiBase: fake.base, apiKey: 'test', timeoutMs: 500 }),
    merchant: { businessId: fake.merchantId, businessSlug: 'mikluha', checkoutOrigin: 'https://checkout.example',
      origin: 'https://book.example', siteOrigin: 'https://site.example' } };
});
const request = () => ({ departureSlug: slug, contact: { phone: '+79039075547', email: 'test@example.ru' },
  passengers: [tourist()], adultsOnlyConfirmed: true, termsRef: deps.catalog.terms.ref, termsHash: deps.catalog.terms.hash,
  pdConsentConfirmed: true, pdConsentRef: deps.catalog.pdConsent.ref, pdConsentHash: deps.catalog.pdConsent.hash });
async function book(seats=1) {
  const r = await reserve({ ...deps, allowDemo: false }, {...request(),passengers:Array.from({length:seats},(_,i)=>tourist(i+1))});
  assert.ok(r.ok, JSON.stringify(r));
  const state = (await issueState(db.pool, r.orderRef))!;
  return { ref: r.orderRef, state };
}
const resolve = (o: { ref: string; state: string }) => onReturn(deps, { rt: 't'.repeat(40), state: o.state, cookieState: () => o.state });
const document = async (ref: string) => (await zayavkaOf(db.pool, ref))!;
const row = async (ref: string) => (await db.owner.query('SELECT * FROM orders WHERE order_ref=$1', [ref])).rows[0];
const pending = () => new Promise<string>(r => setTimeout(() => r('WAIT'), 100));
async function publish(over: Record<string, unknown>) {
  const d = (await db.owner.query(`SELECT d.id, d.published_version, dd.revision, dd.document FROM departure d
    JOIN departure_draft dd ON dd.departure_id=d.id WHERE d.slug=$1`, [slug])).rows[0];
  await db.admin.query('SELECT fn_save_departure_draft($1,$2,$3,$4)', [d.id,d.revision,{ ...d.document,...over },'editor']);
  await db.publisher.query("SELECT fn_publish_departure_change($1,$2,$3,'EQUIVALENT','Equivalent programme update',$4)",
    [d.id,d.revision+1,d.published_version,'owner']);
}

test('a later programme/template/price cannot change any document or receipt of the reserved order', async () => {
  const o = await book();
  const original = (await row(o.ref)).contract_snapshot;
  assert.equal((await row(o.ref)).accepted_departure_version,1);
  await assert.rejects(db.pool.query('UPDATE orders SET accepted_departure_version=NULL WHERE order_ref=$1',[o.ref]), /ORDER_ACCEPTED_REVISION_IMMUTABLE/);
  const contract = structuredClone(original.contract);
  delete contract.departure.departureTime; delete contract.departure.returnTime;
  contract.tour.route = 'New route for new buyers';
  contract.tour.program[0].title = 'New programme';
  contract.departure.accommodation.name = 'New hotel';
  await publish({ contract, priceKopecks: 4_000_000 });
  // Even a missing/stale in-memory catalogue supplies nothing to documents or Refref lines.
  deps = { ...deps, catalog: { ...deps.catalog, departures: new Map(), timezone: 'Europe/Moscow' } };
  assert.equal((await resolve(o)).kind, 'CONFIRM');
  const doc = await document(o.ref);
  assert.match(doc.content!, /Гостевой дом «Озеро»/);
  assert.doesNotMatch(doc.content!, /New route|New programme|New hotel/);
  assert.equal((await row(o.ref)).amount_kopecks, '3400000');
  const newer = await book();
  assert.equal((await row(newer.ref)).amount_kopecks, '4000000');
  assert.equal((await row(newer.ref)).accepted_departure_version,2);
  assert.equal((await pay(deps,o.ref,doc.sha256)).kind, 'REDIRECT');
  const attempt = JSON.parse(fake.attempts.get(o.ref)!.body);
  assert.match(attempt.snapshot.paymentObligations[0].fiscal.items[0].name, /Алтай/);
  assert.equal(attempt.snapshot.totalContractAmountKopecks, 3_400_000);
  assert.equal('inventoryReservation' in attempt, false);
  assert.equal('latePaymentPolicy' in attempt, false);
  assert.deepEqual((await row(o.ref)).contract_snapshot, original);
});

test('repeated and concurrent returns preserve the issued price, document bytes and expiry', async () => {
  const o = await book();
  await Promise.all([resolve(o), resolve(o)]);
  const first = await document(o.ref);
  const quote = (await row(o.ref)).quote_expires_at;
  fake.state.discountKopecks = 100_000;
  clock = new Date(start.getTime() + 14 * minute);
  await resolve(o);
  assert.deepEqual(await document(o.ref),first);
  assert.deepEqual((await row(o.ref)).quote_expires_at, quote);
  assert.equal(fake.calls(/referral-resolutions/).length,1);
  await assert.rejects(db.pool.query("UPDATE order_document SET content='changed' WHERE order_id=(SELECT id FROM orders WHERE order_ref=$1)",[o.ref]), /ORDER_DOCUMENT_FROZEN/);
  await assert.rejects(db.pool.query("UPDATE orders SET quote_expires_at=quote_expires_at+interval '1 second' WHERE order_ref=$1",[o.ref]), /ORDER_QUOTE_IMMUTABLE/);
  clock = new Date(start.getTime() + 15 * minute);
  assert.deepEqual(await pay(deps,o.ref,first.sha256), { kind: 'STATUS',code: 'QUOTE_EXPIRED' });
  assert.equal(fake.attempts.size,0);
});

test('ordinary close admits an issued quote, blocks new quotes and preserves the quoted amount after a price edit', async () => {
  const o = await book(); const unresolved = await book(); await resolve(o);
  await db.owner.query("UPDATE departure SET price_kopecks=4000000,booking_status='CLOSED' WHERE slug=$1",[slug]);
  assert.deepEqual(await reserve({ ...deps,allowDemo:false },request()),{ ok:false,refusal:'DEPARTURE_NOT_OPEN' });
  assert.equal((await resolve(unresolved)).kind,'REFUSED');
  assert.equal((await pay(deps,o.ref,(await document(o.ref)).sha256)).kind,'REDIRECT');
  assert.equal(fake.attempts.get(o.ref)!.payable,3_400_000);
});

test('quote expiry is bounded by Refref expiry and the remaining hold, with an exclusive deadline', async () => {
  const o = await book();
  fake.state.resolutionExpiresAt = new Date(start.getTime()+4*minute).toISOString();
  await resolve(o);
  assert.equal((await row(o.ref)).quote_expires_at.toISOString(),fake.state.resolutionExpiresAt);
  clock = new Date(start.getTime()+4*minute);
  assert.equal((await pay(deps,o.ref,(await document(o.ref)).sha256)).kind,'STATUS');
  const late = await book();
  clock = new Date(start.getTime()+29*minute);
  fake.state.resolutionExpiresAt = new Date(start.getTime()+60*minute).toISOString();
  await resolve(late);
  assert.equal((await row(late.ref)).quote_expires_at.toISOString(),new Date(start.getTime()+34*minute).toISOString());
});

test('payment at minute 25 holds its seat after 30 and 60; a rejected cancellation never releases it', async () => {
  const o = await book();
  clock = new Date(start.getTime()+20*minute); await resolve(o);
  clock = new Date(start.getTime()+25*minute);
  assert.equal((await pay(deps,o.ref,(await document(o.ref)).sha256)).kind,'REDIRECT');
  fake.state.obligation = 'OUTSTANDING'; fake.state.cancel = { status:409,code:'CONFLICT' };
  for (const minutes of [31,61,86,180]) {
    clock = new Date(start.getTime()+minutes*minute);
    await reconcileAll(deps); await maintain(db.pool,()=>undefined,clock);
    assert.equal((await row(o.ref)).status,'PAYMENT_PENDING');
  }
  assert.ok(fake.calls(/\/cancel$/).length>0);
  // The pending order still occupies one of the two seats.
  assert.equal((await reserve({ ...deps,allowDemo:false },{ ...request(),passengers:[tourist(),tourist(2)] })).ok,false);
  fake.state.cancel = 'OK'; await reconcileAll(deps);
  assert.equal((await row(o.ref)).status,'CANCELLED');
});

test('a cancellation stays incomplete for an open attempt, then completes only after safe Refref cancellation', async () => {
  const o = await book(); await resolve(o); await pay(deps,o.ref,(await document(o.ref)).sha256);
  await assert.rejects(db.pool.query("SELECT fn_request_departure_cancellation($1,'runtime','stop')",[slug]), /permission denied/);
  await db.operator.query("SELECT fn_request_departure_cancellation($1,'owner','cancel trip')",[slug]);
  await assert.rejects(db.operator.query("SELECT fn_complete_departure_cancellation($1,'owner','complete')",[slug]), /DEPARTURE_CANCELLATION_UNFINISHED/);
  fake.state.cancel = { status:409,code:'CONFLICT' };
  await reconcileAll(deps);
  assert.equal((await row(o.ref)).status,'PAYMENT_PENDING');
  assert.deepEqual(await pay(deps,o.ref,(await document(o.ref)).sha256), { kind:'STATUS',code:'DEPARTURE_CANCELLED' });
  fake.state.cancel = 'OK'; await reconcileAll(deps);
  await db.operator.query("SELECT fn_complete_departure_cancellation($1,'owner','complete')",[slug]);
  assert.equal((await db.owner.query('SELECT booking_status FROM departure WHERE slug=$1',[slug])).rows[0].booking_status,'CANCELLED');
});

test('global stop leaves read-back and fulfilment available and blocks quote/payment initiation', async () => {
  const paid = await book(); await resolve(paid); await pay(deps,paid.ref,(await document(paid.ref)).sha256);
  const unresolved = await book();
  await setSalesOpen(db.operator,false,'owner','GLOBAL_OPERATOR_STOP');
  const calls = fake.requests.length;
  assert.equal((await resolve(unresolved)).kind,'REFUSED');
  assert.deepEqual(await pay(deps,paid.ref,(await document(paid.ref)).sha256), { kind:'STATUS',code:'SALES_CLOSED' });
  assert.equal(fake.requests.length,calls);
  fake.state.obligation='SATISFIED'; await reconcileAll(deps);
  assert.equal((await row(paid.ref)).status,'FULFILLED');
});

test('closing a departure serializes with a session in flight, with no early cancellation completion', async () => {
  const o = await book(); await resolve(o);
  const gate = fake.holdSessions();
  const paying = pay(deps,o.ref,(await document(o.ref)).sha256);
  await gate.arrived;
  const closing = db.operator.query("SELECT fn_request_departure_cancellation($1,'owner','cancel')",[slug]);
  try { assert.equal(await Promise.race([closing.then(()=> 'DONE'),pending()]),'WAIT'); }
  finally { gate.release(); }
  assert.equal((await paying).kind,'REDIRECT'); await closing;
  await assert.rejects(db.operator.query("SELECT fn_complete_departure_cancellation($1,'owner','complete')",[slug]), /DEPARTURE_CANCELLATION_UNFINISHED/);
});


test('reservation and quote end at the 24-hour cutoff across local midnight', async () => {
  const date = '2027-07-01';
  await db.owner.query(`UPDATE departure SET starts_on=$2,ends_on=$2,departure_time='00:10',return_time='21:00'
    WHERE slug=$1`,[slug,date]);
  clock = new Date('2027-06-29T16:50:00Z'); // 23:50 local; cutoff is in twenty minutes.
  const o = await book();
  clock = new Date('2027-06-29T17:00:00Z');
  fake.state.resolutionExpiresAt = '2027-06-30T18:00:00Z';
  await resolve(o);
  assert.equal((await row(o.ref)).quote_expires_at.toISOString(),'2027-06-29T17:10:00.000Z');
  clock = new Date('2027-06-29T17:10:00Z');
  assert.deepEqual(await pay(deps,o.ref,(await document(o.ref)).sha256),{kind:'STATUS',code:'BOOKING_CUTOFF_REACHED'});
});

test('an absent or tampered contract snapshot is never replaced by the mutable catalogue', async () => {
  const o = await book();
  await db.owner.query('ALTER TABLE orders DISABLE TRIGGER trg_order_contract_immutable');
  try { await db.owner.query(`UPDATE orders SET contract_snapshot_sha256=$2 WHERE order_ref=$1`,[o.ref,`sha256:${'f'.repeat(64)}`]); }
  finally { await db.owner.query('ALTER TABLE orders ENABLE TRIGGER trg_order_contract_immutable'); }
  assert.deepEqual(await resolve(o),{kind:'REFUSED',code:'ORDER_CONTRACT_INVALID',orderRef:o.ref});
  assert.equal(fake.calls(/referral-resolutions/).length,0);
  assert.equal(await zayavkaOf(db.pool,o.ref),null);
});

test('concurrent pay requests use one accepted document, one frozen attempt and the same idempotency key', async () => {
  const o = await book(); await resolve(o); const doc=await document(o.ref);
  const result=await Promise.all([pay(deps,o.ref,doc.sha256),pay(deps,o.ref,doc.sha256)]);
  assert.ok(result.every(r=>r.kind==='REDIRECT'));
  assert.equal(fake.attempts.size,1);
  assert.deepEqual(await document(o.ref),doc);
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM order_event WHERE order_id=(SELECT id FROM orders WHERE order_ref=$1) AND event='FROZEN'",[o.ref])).rows[0].n,1);
  assert.ok(fake.calls(/checkout-attempts$/).every(r=>r.key===`mk-attempt:${o.ref}`));
});


test('expiry fences an unfinished read-only resolution and rejects its stale callback', async () => {
  const o=await book();
  clock=new Date(start.getTime()+29*minute);
  const gate=fake.holdResolutions();
  const resolving=resolve(o); await gate.arrived;
  const later=new Date(start.getTime()+31*minute);
  const expiry=await maintain(db.pool,()=>undefined,later);
  assert.equal(expiry.expired,1);
  clock=later;
  const replacement=await book();assert.ok(replacement.ref);
  gate.release();
  assert.deepEqual(await resolving,{kind:'REFUSED',code:'ORDER_NOT_PAYABLE',orderRef:o.ref});
  assert.equal((await maintain(db.pool,()=>undefined,later)).expired,0);
  assert.equal((await row(o.ref)).status,'EXPIRED');
  assert.equal(fake.attempts.size,0);
});

test('a publisher holding the departure row makes checkout reread the committed close', async () => {
  await db.owner.query('BEGIN');
  await db.owner.query("UPDATE departure SET booking_status='CLOSED' WHERE slug=$1",[slug]);
  const booking=reserve({...deps,allowDemo:false},request());
  try { assert.equal(await Promise.race([booking.then(()=> 'DONE'),pending()]),'WAIT'); }
  finally { await db.owner.query('COMMIT'); }
  assert.deepEqual(await booking,{ok:false,refusal:'DEPARTURE_NOT_OPEN'});
});

// Pause the caller after FROZEN has committed, before ensureAttempt can acquire admission locks.
for (const stop of ['global', 'departure'] as const) {
  test(`${stop} stop between freeze and dispatch prevents createAttempt in pay and reconciliation`, async () => {
    const o=await book(); await resolve(o);
    let frozen=false;
    let stopped:Promise<unknown>=Promise.resolve();
    const pool=new Proxy(db.pool,{
      get(target,key) {
        if (key==='query') return async (sql:string,values?:unknown[])=>{
          if (frozen && sql.includes('FROM orders WHERE order_ref')) { frozen=false; await stopped; }
          return target.query(sql,values);
        };
        const value=Reflect.get(target,key);
        return typeof value==='function' ? value.bind(target) : value;
      },
    });
    const guarded={...deps,pool,log:(event:string,fields?:Record<string,unknown>)=>{
      audit.log(event,fields);
      if (event==='frozen') {
        frozen=true;
        stopped=stop==='global' ? setSalesOpen(db.operator,false,'owner','stop after freeze')
          : db.operator.query("SELECT fn_request_departure_cancellation($1,'owner','stop after freeze')",[slug]);
      }
    }};
    assert.equal((await pay(guarded,o.ref,(await document(o.ref)).sha256)).kind,'STATUS');
    await stopped;
    await reconcileAll(deps); await reconcileAll(deps);
    assert.equal(fake.calls(/checkout-attempts$/).length,0);
    assert.equal(fake.calls(/payment-session$/).length,0);
    assert.equal((await row(o.ref)).attempt_creation_state,'NOT_STARTED');
    assert.equal((await row(o.ref)).status,stop==='global' ? 'PAYMENT_PENDING' : 'CANCELLED');
    if (stop==='departure') assert.ok(audit.lines.some(l=>l.includes('order_cancelled') && l.includes('ATTEMPT_NOT_STARTED')));
  });
}

test('dispatch evidence survives a stop after arming, with no POST and no false proof of cancellation', async () => {
  const o=await book(); await resolve(o);
  let armed=false;
  const pool=new Proxy(db.initiation,{
    get(target,key) {
      if (key==='connect') return async ()=>{
        const client=await target.connect();
        return new Proxy(client,{
          get(c,k) {
            if (k==='query') return async (sql:string,values?:unknown[])=>{
              const result=await c.query(sql,values);
              if (sql.includes("SET attempt_creation_state='STARTED'")) armed=true;
              if (sql==='COMMIT' && armed) {
                armed=false;
                await setSalesOpen(db.operator,false,'owner','stop after durable dispatch marker');
              }
              return result;
            };
            const value=Reflect.get(c,k); return typeof value==='function' ? value.bind(c) : value;
          },
        });
      };
      const value=Reflect.get(target,key); return typeof value==='function' ? value.bind(target) : value;
    },
  });
  assert.equal((await pay({...deps,initiationPool:pool},o.ref,(await document(o.ref)).sha256)).kind,'STATUS');
  assert.equal(fake.calls(/checkout-attempts$/).length,0);
  assert.equal((await row(o.ref)).attempt_creation_state,'STARTED');
  await assert.rejects(db.pool.query("UPDATE orders SET attempt_creation_state='NOT_STARTED' WHERE order_ref=$1",[o.ref]),/ATTEMPT_CREATION_EVIDENCE_IRREVERSIBLE/);
  clock=new Date(clock.getTime()+90*minute);
  await maintain(db.pool,()=>undefined,clock);
  assert.equal((await row(o.ref)).status,'PAYMENT_PENDING');
});

test('an uncertain POST is read back after cancellation, never re-created on a 404 or released by TTL', async () => {
  const o=await book(); await resolve(o);
  fake.state.attempt='TIMEOUT';
  await pay(deps,o.ref,(await document(o.ref)).sha256);
  assert.equal((await row(o.ref)).attempt_creation_state,'STARTED');
  await db.operator.query("SELECT fn_request_departure_cancellation($1,'owner','cancel uncertain')",[slug]);
  const before=fake.calls(/checkout-attempts$/).length;
  clock=new Date(clock.getTime()+61*minute);
  await reconcileAll(deps); await maintain(db.pool,()=>undefined,clock);
  assert.equal(fake.calls(/checkout-attempts$/).length,before);
  assert.equal((await row(o.ref)).status,'HELD');
  assert.ok(audit.lines.some(l=>l.includes('order_held') && l.includes('ATTEMPT_UNCONFIRMED')));
  await assert.rejects(db.operator.query("SELECT fn_complete_departure_cancellation($1,'owner','complete')",[slug]),/DEPARTURE_CANCELLATION_UNFINISHED/);
});

test('a stop waits for an admitted createAttempt and blocks every subsequent creation', async () => {
  const o=await book(); await resolve(o);
  let arrived!:()=>void; let release!:()=>void;
  const atCreate=new Promise<void>(r=>{arrived=r});
  const proceed=new Promise<void>(r=>{release=r});
  const client=new Proxy(deps.refref,{
    get(target,key) {
      if (key==='createAttempt') return async (...args:Parameters<RefrefClient['createAttempt']>)=>{
        arrived(); await proceed; return target.createAttempt(...args);
      };
      const value=Reflect.get(target,key); return typeof value==='function' ? value.bind(target) : value;
    },
  });
  const paying=pay({...deps,refref:client},o.ref,(await document(o.ref)).sha256);
  await atCreate;
  const closing=setSalesOpen(db.operator,false,'owner','stop in-flight create');
  try { assert.equal(await Promise.race([closing.then(()=> 'DONE'),pending()]),'WAIT'); }
  finally { release(); }
  await paying; await closing;
  assert.equal(fake.calls(/checkout-attempts$/).length,1);
  await reconcileAll(deps);
  assert.equal(fake.calls(/checkout-attempts$/).length,1);
});


test('an accepted create with a lost ACK is recovered and fulfilled after global stop using GET only', async () => {
  const o=await book(); await resolve(o);
  fake.state.attempt='ACCEPTED_TIMEOUT'; fake.state.projection='ERROR_500';
  await pay(deps,o.ref,(await document(o.ref)).sha256);
  assert.equal((await row(o.ref)).checkout_attempt_id,null);
  assert.equal(fake.attempts.size,1);
  await setSalesOpen(db.operator,false,'owner','stop after lost ACK');
  fake.state.projection='OK'; fake.state.obligation='SATISFIED';
  const posts=fake.calls(/checkout-attempts$/).length;
  await reconcileAll(deps);
  assert.equal((await row(o.ref)).status,'FULFILLED');
  assert.equal(fake.calls(/checkout-attempts$/).length,posts);
  assert.equal(fake.calls(/payment-session$/).length,0);
});


const completes=async<T>(work:Promise<T>):Promise<T>=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try { return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('UNEXPECTED_NETWORK_LOCK')),1500)})]); }
  finally {if(timer) clearTimeout(timer);}
};

test('the owner replaces an expired quote atomically without shortening the 30-minute hold',async()=>{
  const o=await book(2); await resolve(o); const saved=await document(o.ref);
  clock=new Date(clock.getTime()+17*minute);
  assert.deepEqual(await reserve({...deps,allowDemo:false},request()),{ok:false,refusal:'NOT_ENOUGH_SEATS'});
  const req={...request(),replacementOrderRef:o.ref,passengers:[tourist(),tourist(2)]};
  const results=await Promise.all([reserve({...deps,allowDemo:false},req),reserve({...deps,allowDemo:false},req)]);
  assert.equal(results.filter(r=>r.ok).length,1);
  const next=results.find(r=>r.ok)!; assert.ok(next.ok);
  assert.equal((await row(o.ref)).status,'CANCELLED');
  assert.equal((await row(next.orderRef)).replaces_order_id,(await row(o.ref)).id);
  assert.deepEqual(await document(o.ref),saved);
  assert.equal((await db.owner.query("SELECT sum(seats)::int AS n FROM orders WHERE status='RESERVED'")).rows[0].n,2);
  assert.ok(audit.lines.some(l=>l.includes('order_cancelled')&&l.includes('QUOTE_REPLACED')));
});

test('a replacement which fails capacity admission rolls back the original hold',async()=>{
  const o=await book(2); await resolve(o); clock=new Date(clock.getTime()+17*minute);
  const denied=await reserve({...deps,allowDemo:false},{...request(),replacementOrderRef:o.ref,passengers:[tourist(),tourist(2),tourist(3)]});
  assert.deepEqual(denied,{ok:false,refusal:'NOT_ENOUGH_SEATS'});
  assert.equal((await row(o.ref)).status,'RESERVED');
});

test('a slow resolution keeps only its order marker; reservation and publish still proceed',async()=>{
  const o=await book();
  const d={...deps,refref:new RefrefClient({apiBase:fake.base,apiKey:'test',timeoutMs:5000})};
  const gate=fake.holdResolutions();
  const resolving=onReturn(d,{rt:'t'.repeat(40),state:o.state,cookieState:()=>o.state});
  await gate.arrived;
  try {
    assert.equal(db.pool.totalCount-db.pool.idleCount,0);
    const other=await completes(book()); assert.ok(other.ref);
    const original=(await row(o.ref)).contract_snapshot;
    const contract=structuredClone(original.contract);
    delete contract.departure.departureTime; delete contract.departure.returnTime;
    contract.tour.route='Equivalent route during resolution';
    await completes(publish({contract}));
    clock=new Date(clock.getTime()+17*minute);
    assert.deepEqual(await reserve({...deps,allowDemo:false},{...request(),replacementOrderRef:o.ref}),{ok:false,refusal:'REPLACEMENT_NOT_AVAILABLE'});
    await completes(setSalesOpen(db.operator,false,'owner','stop while resolving'));
  } finally {gate.release();}
  assert.deepEqual(await resolving,{kind:'REFUSED',code:'SALES_CLOSED',orderRef:o.ref});
  assert.equal((await row(o.ref)).resolution_operation_id,null);
});

test('legal read-back is outside freeze locks and cannot bypass a cancellation committed while it waits',async()=>{
  const o=await book(); await resolve(o);
  let arrived!:()=>void; let release!:()=>void;
  const ready=new Promise<void>(r=>{arrived=r}); const done=new Promise<void>(r=>{release=r});
  const paying=pay({...deps,legalAdmission:{verify:async()=>{arrived();await done;}}},o.ref,(await document(o.ref)).sha256);
  await ready;
  try {
    assert.equal(db.pool.totalCount-db.pool.idleCount,0);
    await completes(book());
    await completes(db.operator.query("SELECT fn_request_departure_cancellation($1,'owner','cancel during legal read')",[slug]));
  } finally {release();}
  assert.deepEqual(await paying,{kind:'STATUS',code:'DEPARTURE_CANCELLED'});
  assert.equal(fake.calls(/checkout-attempts$/).length,0);
});

for (const operation of ['create','session'] as const) {
  test(`slow ${operation} uses a shared stop barrier while reserve and publish remain available`,async()=>{
    const o=await book(); await resolve(o);
    let arrived!:()=>void; let release!:()=>void;
    const reached=new Promise<void>(r=>{arrived=r}); const proceed=new Promise<void>(r=>{release=r});
    const refref=new Proxy(deps.refref,{
      get(target,key) {
        if (key===(operation==='create'?'createAttempt':'paymentSession')) return async(...args:unknown[])=>{
          arrived();await proceed;
          return (target[key as 'createAttempt'] as (...args:unknown[])=>unknown).apply(target,args);
        };
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
      },
    });
    const paying=pay({...deps,refref},o.ref,(await document(o.ref)).sha256);
    await reached;
    try {
      assert.equal(db.pool.totalCount-db.pool.idleCount,0);
      assert.equal(db.initiation.totalCount-db.initiation.idleCount,1);
      await completes(book());
      const contract=structuredClone((await row(o.ref)).contract_snapshot.contract);
      delete contract.departure.departureTime; delete contract.departure.returnTime;
      contract.tour.route=`Equivalent route during ${operation}`;
      await completes(publish({contract}));
    } finally {release();}
    assert.equal((await paying).kind,'REDIRECT');
  });
}

test('duplicate tabs share one slow merchant GET with no held connection or departure lock',async()=>{
  const o=await book();await resolve(o);fake.state.attempt='TIMEOUT';
  await pay(deps,o.ref,(await document(o.ref)).sha256);
  let arrived!:()=>void;let release!:()=>void;let reads=0;
  const reached=new Promise<void>(r=>{arrived=r});const proceed=new Promise<void>(r=>{release=r});
  const refref=new Proxy(deps.refref,{get(target,key){
    if(key==='getMerchantOrder') return async(ref:string)=>{reads++;arrived();await proceed;return target.getMerchantOrder(ref)};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const before=fake.calls(/checkout-attempts$/).length;
  const requests=Promise.all(Array.from({length:15},()=>reconcileAll({...deps,refref})));
  await reached;
  try {
    await Promise.all(Array.from({length:12},()=>db.pool.query('SELECT 1'))); // drain initial short reads
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename='commerce_test_runtime' AND state='idle in transaction'",[db.name])).rows[0].n,0);
    assert.equal(db.initiation.totalCount-db.initiation.idleCount,0);
    await completes(book());
    await completes(db.owner.query('UPDATE departure SET price_kopecks=price_kopecks+100 WHERE slug=$1',[slug]));
    await completes(db.operator.query("SELECT fn_request_departure_cancellation($1,'owner','stop GET')",[slug]));
    assert.equal(reads,1);
  } finally {release();await requests;}
  assert.equal(fake.calls(/checkout-attempts$/).length,before);
});

for(const refusal of ['TIMEOUT',{status:403,code:'FORBIDDEN'}] as const) {
  test(`a first dispatch does not depend on merchant GET (${typeof refusal==='string'?refusal:refusal.code})`,async()=>{
    const o=await book();await resolve(o);fake.state.projection=refusal;
    assert.equal((await pay(deps,o.ref,(await document(o.ref)).sha256)).kind,'REDIRECT');
    assert.equal(fake.calls(/merchant-orders/,'GET').length,0);
    assert.equal(fake.calls(/checkout-attempts$/).length,1);
    assert.equal((await row(o.ref)).status,'PAYMENT_PENDING');
  });
}

test('resolution audits the attribution source and recovery divergence emits operator logs',async()=>{
  fake.state.discountKopecks=100_000;
  const o=await book();await resolve(o);
  assert.equal((await db.owner.query("SELECT detail FROM order_event WHERE order_id=$1 AND event='RESOLVED'",[(await row(o.ref)).id])).rows[0].detail,'GRANT');
  fake.state.attempt='ACCEPTED_TIMEOUT';fake.state.projectionMismatch=true;
  await pay(deps,o.ref,(await document(o.ref)).sha256);
  assert.ok(audit.lines.some(l=>l.includes('order_held')&&l.includes('ATTEMPT_RECOVERY_MISMATCH')));
  assert.ok(audit.lines.every(l=>!l.includes('Иван')&&!l.includes('654321')));
});


test('a failed application render rolls back quote evidence and clears only its own operation token',async()=>{
  const o=await book();
  await db.owner.query('DELETE FROM order_contact WHERE order_id=$1',[(await row(o.ref)).id]);
  assert.deepEqual(await resolve(o),{kind:'REFUSED',code:'ORDER_CONTRACT_INVALID',orderRef:o.ref});
  const saved=await row(o.ref);
  assert.equal(saved.quote_issued_at,null);assert.equal(saved.payable_kopecks,null);assert.equal(saved.resolution_operation_id,null);
  assert.equal(await zayavkaOf(db.pool,o.ref),null);
});

test('last-five-minute hold ends at cutoff; new reserve and resolve are refused at the boundary',async()=>{
  await db.owner.query("UPDATE departure SET starts_on='2027-07-01',ends_on='2027-07-01',departure_time='06:00' WHERE slug=$1",[slug]);
  clock=new Date('2027-06-29T22:55:00Z');
  const o=await book();
  assert.equal((await row(o.ref)).reserved_until.toISOString(),'2027-06-29T23:00:00.000Z');
  clock=new Date('2027-06-29T23:00:00Z');
  assert.deepEqual(await reserve({...deps,allowDemo:false},request()),{ok:false,refusal:'BOOKING_CUTOFF_REACHED'});
  assert.deepEqual(await resolve(o),{kind:'REFUSED',code:'BOOKING_CUTOFF_REACHED',orderRef:o.ref});
  assert.equal(fake.requests.length,0);
});

test('a resolve arriving at cutoff cannot issue a quote',async()=>{
  await db.owner.query("UPDATE departure SET starts_on='2027-07-01',ends_on='2027-07-01',departure_time='06:00' WHERE slug=$1",[slug]);
  clock=new Date('2027-06-29T22:59:59Z');
  const o=await book(); const gate=fake.holdResolutions(); const resolving=resolve(o);
  await gate.arrived;
  clock=new Date('2027-06-29T23:00:00Z'); gate.release();
  assert.deepEqual(await resolving,{kind:'REFUSED',code:'BOOKING_CUTOFF_REACHED',orderRef:o.ref});
  assert.equal((await row(o.ref)).quote_issued_at,null);
  assert.equal(await zayavkaOf(db.pool,o.ref),null);
});

test('cutoff blocks new sessions while money already in progress can still settle',async()=>{
  await db.owner.query("UPDATE departure SET starts_on='2027-07-01',ends_on='2027-07-01',departure_time='06:00' WHERE slug=$1",[slug]);
  clock=new Date('2027-06-29T22:55:00Z'); fake.state.resolutionExpiresAt='2027-06-30T01:00:00Z';
  const o=await book(); await resolve(o); const hash=(await document(o.ref)).sha256;
  assert.equal((await pay(deps,o.ref,hash)).kind,'REDIRECT');
  const calls=fake.requests.length;
  clock=new Date('2027-06-29T23:00:00Z');
  assert.deepEqual(await pay(deps,o.ref,hash),{kind:'STATUS',code:'BOOKING_CUTOFF_REACHED'});
  assert.equal(fake.requests.length,calls);
  await maintain(db.pool,()=>undefined,clock);
  assert.equal((await row(o.ref)).status,'PAYMENT_PENDING');
  fake.state.obligation='SATISFIED'; await reconcileAll(deps);
  assert.equal((await row(o.ref)).status,'FULFILLED');
});

test('mutable schedule edits cannot extend an existing order cutoff',async()=>{
  await db.owner.query("UPDATE departure SET starts_on='2027-07-01',ends_on='2027-07-01',departure_time='06:00' WHERE slug=$1",[slug]);
  clock=new Date('2027-06-29T22:55:00Z'); fake.state.resolutionExpiresAt='2027-06-30T01:00:00Z';
  const o=await book(); await resolve(o); const hash=(await document(o.ref)).sha256;
  await db.owner.query('ALTER TABLE departure DISABLE TRIGGER USER');
  try { await db.owner.query("UPDATE departure SET starts_on='2027-07-05',ends_on='2027-07-05' WHERE slug=$1",[slug]); }
  finally { await db.owner.query('ALTER TABLE departure ENABLE TRIGGER USER'); }
  clock=new Date('2027-06-29T23:00:00Z');
  assert.deepEqual(await pay(deps,o.ref,hash),{kind:'STATUS',code:'BOOKING_CUTOFF_REACHED'});
  assert.equal(fake.calls(/checkout-attempts$/).length,0);
});

test('maintain revokes a crashed resolve lease and fences its response after retry',async()=>{
  const o=await book(); const gate=fake.holdResolutions(); const old=resolve(o); await gate.arrived;
  const token=(await row(o.ref)).resolution_operation_id;
  clock=new Date(clock.getTime()+2*minute);
  await maintain(db.pool,()=>undefined,clock);
  assert.equal((await row(o.ref)).resolution_operation_id,null);
  const retry=await onReturn({...deps,pool:new Proxy(db.pool,{})},{rt:'t'.repeat(40),state:o.state,cookieState:()=>o.state});
  assert.equal(retry.kind,'CONFIRM'); const before=await document(o.ref);
  gate.release();
  assert.deepEqual(await old,{kind:'REFUSED',code:'ORDER_NOT_PAYABLE',orderRef:o.ref});
  assert.equal((await document(o.ref)).content,before.content);
  assert.equal((await row(o.ref)).resolution_operation_id,null);
  assert.ok(token);
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM order_event WHERE event='RESOLUTION_LEASE_EXPIRED'")).rows[0].n,1);
  const calls=fake.calls(/referral-resolutions/);
  assert.deepEqual(calls[0]!.body,calls[1]!.body);
});

test('an expired lease refuses its response even before maintain runs',async()=>{
  const o=await book(); const gate=fake.holdResolutions(); const old=resolve(o); await gate.arrived;
  clock=new Date(clock.getTime()+2*minute); gate.release();
  assert.deepEqual(await old,{kind:'REFUSED',code:'RESOLUTION_LEASE_EXPIRED',orderRef:o.ref});
  assert.equal(await zayavkaOf(db.pool,o.ref),null);
});

test('two stalled initiations bound the third wait without losing seats or payment identity',{timeout:12_000},async()=>{
  await db.owner.query('UPDATE departure SET capacity=4 WHERE slug=$1',[slug]);
  const orders=[]; for(let i=0;i<3;i++){const o=await book();await resolve(o);orders.push({...o,hash:(await document(o.ref)).sha256});}
  let release!:()=>void; const gate=new Promise<void>(r=>{release=r;});
  let both!:()=>void; const arrived=new Promise<void>(r=>{both=r;}); let n=0;
  const create=deps.refref.createAttempt.bind(deps.refref);
  deps.refref.createAttempt=async(...args)=>{ if(++n===2) both(); await gate; return create(...args); };
  const first=orders.slice(0,2).map(o=>pay(deps,o.ref,o.hash));
  await arrived;
  try {
    const at=Date.now(); const third=orders[2]!;
    assert.deepEqual(await pay(deps,third.ref,third.hash),{kind:'STATUS',code:'PAYMENT_TEMPORARILY_BUSY'});
    assert.ok(Date.now()-at>=2800 && Date.now()-at<5000);
    assert.equal((await row(third.ref)).status,'PAYMENT_PENDING');
    assert.equal((await row(third.ref)).checkout_attempt_id,null);
    assert.equal((await row(third.ref)).attempt_creation_state,'NOT_STARTED');
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM order_event e JOIN orders o ON o.id=e.order_id WHERE o.order_ref=$1 AND e.event='ATTEMPT_DISPATCH_ARMED'",[third.ref])).rows[0].n,0);
    assert.equal((await db.owner.query("SELECT sum(seats)::int AS n FROM orders WHERE status='PAYMENT_PENDING'")).rows[0].n,3);
    assert.equal(fake.calls(/checkout-attempts$/).length,0);
  } finally { release(); }
  assert.ok((await Promise.all(first)).every(r=>r.kind==='REDIRECT'));
  fake.state.projection={status:403,code:'FORBIDDEN'}; // a fresh retry must not need the read capability
  const reads=fake.calls(/merchant-orders/,'GET').length;
  const third=orders[2]!; assert.equal((await pay(deps,third.ref,third.hash)).kind,'REDIRECT');
  assert.equal(fake.calls(/merchant-orders/,'GET').length,reads);
  assert.equal(fake.attempts.size,3);
  assert.ok(fake.calls(/checkout-attempts$/).every(r=>r.key===`mk-attempt:${r.path.split('/')[3]}`));
});

test('a lost hold race emits neither a false technical log nor a HELD event',async()=>{
  const o=await book(); await resolve(o); await pay(deps,o.ref,(await document(o.ref)).sha256);
  const get=deps.refref.getAttempt.bind(deps.refref);
  deps.refref.getAttempt=async(...args)=>{
    const reply=await get(...args);
    await db.owner.query("UPDATE orders SET status='CANCELLED',closed_at=$2 WHERE order_ref=$1",[o.ref,clock]);
    if(reply.kind==='ANSWERED') reply.body.snapshotHash='crossed';
    return reply;
  };
  await reconcileAll(deps);
  assert.equal(audit.lines.filter(l=>JSON.parse(l).event==='order_held').length,0);
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM order_event WHERE event='HELD'")).rows[0].n,0);
});

test('a failed COMMIT emits no hold log and leaves no transition event',async()=>{
  const o=await book(); await resolve(o); await pay(deps,o.ref,(await document(o.ref)).sha256);
  await db.owner.query(`CREATE FUNCTION test_fail_held_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_COMMIT_REFUSED'; END $$`);
  await db.owner.query(`CREATE CONSTRAINT TRIGGER test_fail_held_commit AFTER INSERT ON order_event
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.event='HELD') EXECUTE FUNCTION test_fail_held_commit()`);
  fake.state.paymentAmountDelta=-1; fake.state.obligation='SATISFIED';
  try {
    await reconcileAll(deps);
    assert.equal((await row(o.ref)).status,'PAYMENT_PENDING');
    assert.equal(audit.lines.filter(l=>JSON.parse(l).event==='order_held').length,0);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM order_event WHERE event='HELD'")).rows[0].n,0);
  } finally { await db.owner.query('DROP TRIGGER test_fail_held_commit ON order_event'); await db.owner.query('DROP FUNCTION test_fail_held_commit()'); }
});

// Deterministic clock changes at actual DB boundaries, without timing sleeps.
function afterQuery(pool:TestDb['pool'],match:(sql:string)=>boolean,action:()=>void):TestDb['pool'] {
  return new Proxy(pool,{get(target,key){
    if(key==='connect') return async()=>{
      const client=await target.connect();
      return new Proxy(client,{get(c,k){
        if(k==='query') return async(sql:string,values?:unknown[])=>{
          const result=await c.query(sql,values); if(match(sql)) action(); return result;
        };
        const value=Reflect.get(c,k); return typeof value==='function'?value.bind(c):value;
      }});
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
}

test('reservation rechecks the cutoff after capacity reads and rolls back a late insert',async()=>{
  await db.owner.query("UPDATE departure SET starts_on='2027-07-01',ends_on='2027-07-01',departure_time='06:00' WHERE slug=$1",[slug]);
  clock=new Date('2027-06-29T22:59:59Z');
  const pool=afterQuery(db.pool,sql=>sql.includes('fn_departure_taken_seats'),()=>{clock=new Date('2027-06-29T23:00:00Z');});
  assert.deepEqual(await reserve({...deps,pool,allowDemo:false},request()),{ok:false,refusal:'BOOKING_CUTOFF_REACHED'});
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM orders')).rows[0].n,0);
});

test('attempt dispatch rechecks the cutoff after its last awaited advisory lock',async()=>{
  await db.owner.query("UPDATE departure SET starts_on='2027-07-01',ends_on='2027-07-01',departure_time='06:00' WHERE slug=$1",[slug]);
  clock=new Date('2027-06-29T22:59:59Z');fake.state.resolutionExpiresAt='2027-06-30T01:00:00Z';
  const o=await book();await resolve(o);
  const initiationPool=afterQuery(db.initiation,sql=>sql.includes('pg_try_advisory_xact_lock'),()=>{clock=new Date('2027-06-29T23:00:00Z');});
  await pay({...deps,initiationPool},o.ref,(await document(o.ref)).sha256);
  assert.equal(fake.calls(/checkout-attempts$/).length,0);
  assert.equal(fake.calls(/payment-session$/).length,0);
  assert.equal((await row(o.ref)).status,'PAYMENT_PENDING');
});

test('maintenance revokes pre-upgrade undated resolve tokens only without payment evidence',async()=>{
  const unpaid=await book(); const pending=await book();await resolve(pending);
  await pay(deps,pending.ref,(await document(pending.ref)).sha256);
  await db.owner.query("UPDATE orders SET resolution_operation_id=gen_random_uuid(),resolution_started_at=NULL WHERE order_ref=ANY($1)",[[unpaid.ref,pending.ref]]);
  await maintain(db.pool,()=>undefined,clock);
  assert.equal((await row(unpaid.ref)).resolution_operation_id,null);
  assert.ok((await row(pending.ref)).resolution_operation_id);
  assert.equal((await row(pending.ref)).status,'PAYMENT_PENDING');
  assert.equal((await resolve(unpaid)).kind,'CONFIRM');
});


test('arming and dispatch need no nested checkout even with one shared pool connection',{timeout:5000},async()=>{
  const o=await book();await resolve(o);
  const pool=new pg.Pool({...db.pool.options,max:1,connectionTimeoutMillis:1000});
  try {
    assert.equal((await pay({...deps,pool,initiationPool:pool},o.ref,(await document(o.ref)).sha256)).kind,'REDIRECT');
    assert.equal(fake.attempts.size,1);
  } finally { await pool.end(); }
});

test('a worker arming during pool wait forces recovery before any subsequent POST',async()=>{
  const o=await book();await resolve(o);let otherWorker=true;
  const initiationPool=new Proxy(db.initiation,{get(target,key){
    if(key==='connect') return async()=>{
      if(otherWorker){
        otherWorker=false;
        await db.owner.query("UPDATE orders SET attempt_creation_state='STARTED' WHERE order_ref=$1",[o.ref]);
      }
      return target.connect();
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  fake.state.projection={status:403,code:'FORBIDDEN'};
  await pay({...deps,initiationPool},o.ref,(await document(o.ref)).sha256);
  assert.equal(fake.calls(/merchant-orders/,'GET').length,1);
  assert.equal(fake.calls(/checkout-attempts$/).length,0);
  assert.equal((await row(o.ref)).status,'HELD');
  assert.equal((await row(o.ref)).attempt_creation_state,'STARTED');
});
