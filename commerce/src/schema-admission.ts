import { AsyncLocalStorage } from 'node:async_hooks';

import type { SchemaReadiness } from './schema-readiness.js';

/** Per-operation admission, separate from routing/health and the legal-release gate.
 * Does not cancel already-admitted work: incompatible SQL requires stop + drain first.
 */
export class SchemaAdmission {
  #stopping = false;
  readonly #request = new AsyncLocalStorage<{ active: boolean }>();
  readonly #pending = new Set<Promise<SchemaReadiness>>();
  constructor(private readonly check: () => Promise<SchemaReadiness>) {}

  async status(): Promise<SchemaReadiness> {
    if (this.#stopping) return { status: 'NOT_READY', reason: 'RUNTIME_DRAINING' };
    try {
      const result = await this.check();
      return this.#stopping ? { status: 'NOT_READY', reason: 'RUNTIME_DRAINING' } : result;
    }
    catch { return { status: 'NOT_READY', reason: 'DATABASE_UNAVAILABLE' }; }
  }

  run(work: () => Promise<unknown>): Promise<SchemaReadiness> {
    const pending = (async () => {
      const result = await this.status();
      if (this.#stopping) return { status: 'NOT_READY' as const, reason: 'RUNTIME_DRAINING' };
      if (result.status !== 'READY') return result;
      await work();
      return result;
    })();
    this.#pending.add(pending);
    return pending.finally(() => { this.#pending.delete(pending); });
  }

  /** Only this live, already-admitted request may extend its drain obligation.
   * The shared lease is revoked on return, including in detached async descendants.
   */
  runRequest(work: () => Promise<unknown>): Promise<SchemaReadiness> {
    return this.run(async () => {
      const lease = { active: true };
      try { await this.#request.run(lease, work); }
      finally { lease.active = false; }
    });
  }

  canScheduleFromRequest(): boolean { return this.#request.getStore()?.active === true; }

  /** Register before shutdown or from a still-live admitted request. Wait for response close,
   * then recheck live schema; ordinary new run/status still refuse during drain.
   */
  schedule(start: Promise<void>, work: () => Promise<unknown>): Promise<SchemaReadiness> {
    if (this.#stopping && !this.canScheduleFromRequest()) return Promise.resolve({ status: 'NOT_READY', reason: 'RUNTIME_DRAINING' });
    const pending = (async () => {
      await start;
      let result: SchemaReadiness;
      try { result = await this.check(); }
      catch { return { status: 'NOT_READY' as const, reason: 'DATABASE_UNAVAILABLE' }; }
      if (result.status === 'READY') await work();
      return result;
    })();
    this.#pending.add(pending);
    return pending.finally(() => { this.#pending.delete(pending); });
  }

  async drain(): Promise<void> {
    this.#stopping = true;
    // An admitted request can register a response-close ticket before it returns.
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}

/** A timer cannot overlap itself. Recheck between steps, including after remote I/O. */
export function schemaWorker(admission: SchemaAdmission, steps: readonly (() => Promise<unknown>)[], onError: (error: unknown) => void) {
  let stopping = false;
  let running: Promise<void> | undefined;
  return {
    tick(): Promise<void> {
      if (stopping) return Promise.resolve();
      if (running) return running;
      running = (async () => {
        for (const step of steps) {
          if (stopping || (await admission.run(step)).status !== 'READY') break;
        }
      })().catch(onError).finally(() => { running = undefined; });
      return running;
    },
    stop(): void { stopping = true; },
    async drain(): Promise<void> { stopping = true; await running; },
  };
}
