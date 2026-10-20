// What the Admin API can prove and the database alone cannot (migration 0011, review of ART-363).
// Every key here is derived from ADMIN_TOTP_KEY (HKDF-SHA256, one label each) and lives only in the
// Admin API's process: none is stored in, or computable from, the database.
//
//   session    the database stores HMAC(session key, token), not a hash anyone can compute: a session
//              row written with admin_app's credentials alone names no token that anyone holds, so
//              it is never accepted over HTTP.
//   audit      every audit row the Admin API writes carries HMAC(audit key, the row). AUTH.LOGIN is
//              attested only after the password and the TOTP code were checked here, and a publish
//              row names its session and that AUTH.LOGIN row, so the chain verifies end to end; a row
//              written with the database's credentials alone does not.
//   throttle   login throttle buckets are HMACs of the client source or login, never either one.

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export interface AdminKeys {
  readonly session: Buffer;
  readonly audit: Buffer;
  readonly throttle: Buffer;
}

const derive = (root: Buffer, label: string) => Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), label, 32));

export function adminKeys(totpKey: Buffer): AdminKeys {
  return {
    session: derive(totpKey, 'mikluha.admin-session/1'),
    audit: derive(totpKey, 'mikluha.admin-audit/1'),
    throttle: derive(totpKey, 'mikluha.admin-throttle/1'),
  };
}

const mac = (key: Buffer, value: string) => createHmac('sha256', key).update(value, 'utf8').digest('hex');

/** What admin_session.token_mac holds for a cookie token. */
export const tokenMac = (sessionKey: Buffer, token: string) => mac(sessionKey, `token\0${token}`);

export type DetailValue = string | number | boolean | null;

/** An audit row as stored, without what the database stamps itself (id, time, login). */
export interface AttestedRow {
  readonly adminId: string | null;
  readonly actor: string;
  readonly action: string;
  readonly outcome: 'OK' | 'REFUSED';
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly details: Readonly<Record<string, DetailValue>>;
}

/** One byte string per row: fixed field order, detail keys sorted. jsonb keeps these values exactly. */
function canonical(row: AttestedRow): string {
  const details = Object.keys(row.details).sort().map(k => [k, row.details[k] ?? null]);
  return JSON.stringify(['mikluha.admin-audit/1', row.adminId, row.actor, row.action, row.outcome,
    row.entityType, row.entityId, details]);
}

export const attest = (auditKey: Buffer, row: AttestedRow) => mac(auditKey, canonical(row));

export function verifyAttestation(auditKey: Buffer, row: AttestedRow, attestation: string | null): boolean {
  if (attestation === null || !/^[0-9a-f]{64}$/.test(attestation)) return false;
  return timingSafeEqual(Buffer.from(attest(auditKey, row), 'hex'), Buffer.from(attestation, 'hex'));
}
