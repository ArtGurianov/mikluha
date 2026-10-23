import type { SchemaReadiness } from './schema-readiness.js';

/** Per-operation admission, separate from routing/health and the legal-release gate.
 * Does not cancel already-admitted work: incompatible SQL requires stop + drain first.
 */
export class SchemaAdmission {
  #stopping = false;
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

  async drain(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled([...this.#pending]);
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
