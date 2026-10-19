// Content CRUD for the isolated Admin API (ADR v2.3 §2–§4, migration 0009, ART-358). Every call goes
// through a SECURITY DEFINER function as the admin_app login: the database checks expected versions,
// identity, the date lock, the relation graph and the execution-change classification, and audits
// each command. This module only names the calls and turns refusals into typed errors.

import type pg from 'pg';

export type ContentKind = 'report' | 'review' | 'organizer' | 'legal';
export type Classification = 'EQUIVALENT' | 'MATERIAL';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Document = { [key: string]: Json };

/** Refusal codes the editorial functions raise; anything else is rethrown as it came. */
export const EDITORIAL_CODES = [
  'DRAFT_REVISION_CONFLICT', 'PUBLISHED_VERSION_CONFLICT',
  'EXECUTION_CHANGE_CLASSIFICATION_REQUIRED', 'EXECUTION_CHANGE_CLASSIFICATION_INVALID', 'EXECUTION_CHANGE_NOT_REQUIRED',
  'EXECUTION_CHANGE_NOTICE_INVALID', 'DEPARTURE_SCHEDULE_LOCKED', 'DEPARTURE_OPEN_REQUIRES_COMPLETE_OFFER',
  'EXECUTION_CHANGE_CONFLICT',
  'TOUR_DOCUMENT_INVALID', 'DEPARTURE_DOCUMENT_INVALID', 'CONTENT_DOCUMENT_INVALID',
  'TOUR_UNKNOWN', 'DEPARTURE_UNKNOWN', 'CONTENT_UNKNOWN', 'TOUR_NOT_PUBLISHED',
  'RELATION_NOT_PUBLISHED', 'RELATION_MISMATCH', 'LEGAL_PUBLICATION_NOT_ADMITTED',
  'TOUR_IDENTITY_IMMUTABLE', 'DEPARTURE_IDENTITY_IMMUTABLE', 'CONTENT_IDENTITY_IMMUTABLE',
  'EDITORIAL_ACTOR_INVALID', 'EDITORIAL_SERVICE_LOGIN',
] as const;
export type EditorialCode = typeof EDITORIAL_CODES[number] | 'SLUG_TAKEN';

const CONFLICTS: ReadonlySet<EditorialCode> = new Set([
  'DRAFT_REVISION_CONFLICT', 'PUBLISHED_VERSION_CONFLICT', 'EXECUTION_CHANGE_CONFLICT',
]);

export class EditorialError extends Error {
  readonly code: EditorialCode;
  /** Stale versions or an already-classified operation: reload its state; this call wrote nothing. */
  readonly conflict: boolean;
  constructor(code: EditorialCode, message: string) {
    super(message);
    this.name = 'EditorialError';
    this.code = code;
    this.conflict = CONFLICTS.has(code);
  }
}

function refusal(e: unknown): never {
  const err = e as { code?: unknown; message?: unknown; constraint?: unknown };
  if (err?.code === '23505' && typeof err.constraint === 'string' && /slug/.test(err.constraint)) {
    throw new EditorialError('SLUG_TAKEN', 'SLUG_TAKEN');
  }
  const message = typeof err?.message === 'string' ? err.message : '';
  const code = EDITORIAL_CODES.find((c) => message === c || message.startsWith(`${c}:`) || message.startsWith(`${c} `));
  if (code !== undefined) throw new EditorialError(code, message);
  throw e;
}

async function call<T>(pool: pg.Pool, sql: string, args: unknown[]): Promise<T> {
  try {
    return (await pool.query<{ r: T }>(sql, args)).rows[0]!.r;
  } catch (e) { return refusal(e); }
}

export const createTour = (pool: pg.Pool, slug: string, by: string): Promise<string> =>
  call(pool, 'SELECT fn_create_tour($1, $2) AS r', [slug, by]);

/** The new departure is CLOSED and unlisted, with draft revision 1 holding the tour's template. */
export const createDeparture = (pool: pg.Pool, tourId: string, slug: string, by: string): Promise<string> =>
  call(pool, 'SELECT fn_create_departure($1, $2, $3) AS r', [tourId, slug, by]);

export const createContentItem = (pool: pg.Pool, kind: ContentKind, slug: string, by: string): Promise<string> =>
  call(pool, 'SELECT fn_create_content_item($1, $2, $3) AS r', [kind, slug, by]);

/** Save draft never changes what the public sees. `expectedRevision` is the draft revision the editor saw (0: none). */
export const saveTourDraft = (pool: pg.Pool, id: string, expectedRevision: number, document: Document, by: string): Promise<number> =>
  call(pool, 'SELECT fn_save_tour_draft($1, $2, $3, $4) AS r', [id, expectedRevision, document, by]);

export const saveDepartureDraft = (pool: pg.Pool, id: string, expectedRevision: number, document: Document, by: string): Promise<number> =>
  call(pool, 'SELECT fn_save_departure_draft($1, $2, $3, $4) AS r', [id, expectedRevision, document, by]);

export const saveContentDraft = (pool: pg.Pool, id: string, expectedRevision: number, document: Document, by: string): Promise<number> =>
  call(pool, 'SELECT fn_save_content_draft($1, $2, $3, $4) AS r', [id, expectedRevision, document, by]);

export interface Expected {
  readonly draftRevision: number;
  /** The published version the editor saw (0: never published). */
  readonly publishedVersion: number;
}

export const publishTour = (pool: pg.Pool, id: string, expected: Expected, by: string): Promise<number> =>
  call(pool, 'SELECT fn_publish_tour($1, $2, $3, $4) AS r', [id, expected.draftRevision, expected.publishedVersion, by]);

export const publishContentItem = (pool: pg.Pool, id: string, expected: Expected, by: string): Promise<number> =>
  call(pool, 'SELECT fn_publish_content_item($1, $2, $3, $4) AS r', [id, expected.draftRevision, expected.publishedVersion, by]);

export interface DeparturePublication {
  /** PUBLISHED: an ordinary edit. APPLIED: an EQUIVALENT change, one notice per affected order. ROUTED_TO_MOVE_CANCEL: nothing published. */
  readonly outcome: 'PUBLISHED' | 'APPLIED' | 'ROUTED_TO_MOVE_CANCEL';
  readonly version: number;
  readonly changeId: string | null;
  readonly affectedOrders: number;
}

/**
 * Publish a departure. A contract change on a departure with active or concluded orders needs
 * `change`; anything else must go without it.
 * An exact MATERIAL retry returns the original result; a different notice or classification for
 * the same published version and draft revision conflicts (migration 0010).
 */
export const publishDeparture = (pool: pg.Pool, id: string, expected: Expected, by: string,
  change?: { readonly classification: Classification; readonly notice: string }): Promise<DeparturePublication> =>
  call(pool, 'SELECT fn_publish_departure_change($1, $2, $3, $4, $5, $6) AS r',
    [id, expected.draftRevision, expected.publishedVersion, change?.classification ?? null, change?.notice ?? null, by]);

/** What Control Room shows before asking for a classification: order references and states, no personal data. */
export async function affectedOrders(pool: pg.Pool, departureId: string): Promise<{ orderRef: string; status: string }[]> {
  try {
    const { rows } = await pool.query<{ order_ref: string; status: string }>(
      'SELECT order_ref, status FROM fn_departure_affected_orders($1)', [departureId]);
    return rows.map((r) => ({ orderRef: r.order_ref, status: r.status }));
  } catch (e) { return refusal(e); }
}

export interface NoticeStatus {
  readonly orderId: string;
  readonly state: 'PENDING' | 'SENDING' | 'ACCEPTED' | 'DELIVERED' | 'ATTENTION';
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly acceptedAt: Date | null;
  readonly deliveredAt: Date | null;
}

/** The per-order notices of one execution change, for Control Room. */
export async function changeNotices(pool: pg.Pool, changeId: string): Promise<NoticeStatus[]> {
  const { rows } = await pool.query<{ order_id: string; state: NoticeStatus['state']; attempts: number;
    last_error_code: string | null; accepted_at: Date | null; delivered_at: Date | null }>(
    `SELECT order_id, state, attempts, last_error_code, accepted_at, delivered_at FROM execution_change_notice
      WHERE change_id = $1 ORDER BY created_at, order_id`, [changeId]);
  return rows.map((r) => ({ orderId: r.order_id, state: r.state, attempts: r.attempts, lastErrorCode: r.last_error_code,
    acceptedAt: r.accepted_at, deliveredAt: r.delivered_at }));
}
