// What the Admin API can prove and the database alone cannot (migration 0011, review of ART-363).
// Session/throttle keys derive from ADMIN_TOTP_KEY; audit uses an independent versioned keyring.
// All live only in the Admin API's process, never in the database.
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
  readonly auditKeyId: string;
  readonly auditVerify: ReadonlyMap<string, Buffer>;
}

const derive = (root: Buffer, label: string) => Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), label, 32));

export interface AuditKeyring {
  readonly id: string;
  readonly key: Buffer;
  readonly previous?: ReadonlyMap<string, Buffer>;
}

/** Standalone audit keys: rotating TOTP/session authority never invalidates audit history. */
export function parseAuditKeys(env: NodeJS.ProcessEnv): AuditKeyring {
  const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
  const parse = (value: unknown) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('CONFIG_INVALID: ADMIN_AUDIT_KEY');
    const key = Buffer.from(value, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== value) throw new Error('CONFIG_INVALID: ADMIN_AUDIT_KEY');
    return key;
  };
  const id = env.ADMIN_AUDIT_KEY_ID ?? '';
  if (!validId(id)) throw new Error('CONFIG_INVALID: ADMIN_AUDIT_KEY_ID');
  const key = parse(env.ADMIN_AUDIT_KEY);
  let history: unknown;
  try { history = JSON.parse(env.ADMIN_AUDIT_PREVIOUS_KEYS ?? '{}'); }
  catch { throw new Error('CONFIG_INVALID: ADMIN_AUDIT_PREVIOUS_KEYS'); }
  if (history === null || typeof history !== 'object' || Array.isArray(history)) throw new Error('CONFIG_INVALID: ADMIN_AUDIT_PREVIOUS_KEYS');
  const previous = new Map<string, Buffer>();
  for (const [oldId, value] of Object.entries(history)) {
    if (!validId(oldId) || oldId === id) throw new Error('CONFIG_INVALID: ADMIN_AUDIT_PREVIOUS_KEYS');
    previous.set(oldId, parse(value));
  }
  return { id, key, previous };
}

export function adminKeys(totpKey: Buffer, audit: AuditKeyring): AdminKeys {
  return {
    session: derive(totpKey, 'mikluha.admin-session/1'),
    audit: audit.key,
    auditKeyId: audit.id,
    auditVerify: new Map([...(audit.previous ?? []), [audit.id, audit.key]]),
    throttle: derive(totpKey, 'mikluha.admin-throttle/1'),
  };
}

const mac = (key: Buffer, value: string) => createHmac('sha256', key).update(value, 'utf8').digest('hex');

/** What admin_session.token_mac holds for a cookie token. */
export const tokenMac = (sessionKey: Buffer, token: string) => mac(sessionKey, `token\0${token}`);

export type DetailValue = string | number | boolean | null;

/** UUID/key identity and DB login are signed; DB id/time are stamped and append-only. */
export interface AttestedRow {
  readonly eventId: string;
  readonly keyId: string;
  readonly loginRole: string;
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
  return JSON.stringify(['mikluha.admin-audit/2', row.eventId, row.keyId, row.loginRole, row.adminId, row.actor, row.action, row.outcome,
    row.entityType, row.entityId, details]);
}

export const attest = (auditKey: Buffer, row: AttestedRow) => mac(auditKey, canonical(row));

export function verifyAttestation(auditKey: Buffer, row: AttestedRow, attestation: string | null): boolean {
  if (attestation === null || !/^[0-9a-f]{64}$/.test(attestation)) return false;
  return timingSafeEqual(Buffer.from(attest(auditKey, row), 'hex'), Buffer.from(attestation, 'hex'));
}

export function auditEvidence(keys: AdminKeys, row: AttestedRow, attestation: string | null): 'OPERATOR' | 'ATTESTED' | 'FORGED' | 'UNVERIFIABLE' {
  if (attestation === null) return 'OPERATOR';
  const key = keys.auditVerify.get(row.keyId);
  if (key === undefined) return 'UNVERIFIABLE';
  return verifyAttestation(key, row, attestation) ? 'ATTESTED' : 'FORGED';
}
