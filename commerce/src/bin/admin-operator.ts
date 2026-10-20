// Admin accounts, by an OPERATOR over SSH with the admin operator credential (a login in
// admin_operator; never the Admin API's ADMIN_DATABASE_URL). Run in a one-off container from the
// image, never `docker exec` into the Admin API (commerce/README.md, "Admin API"):
//
//   admin-operator status
//   admin-operator user add <login> --role OWNER|EDITOR --by <who>    password on stdin
//   admin-operator user password <login> --by <who>                  password on stdin; revokes sessions
//   admin-operator user disable|enable <login> --by <who> --reason "<why>"
//   admin-operator totp reset <login> --by <who> --reason "<why>"     lost device: re-enrolment within 24 h
//   admin-operator sessions revoke <login> --by <who> --reason "<why>"
//   admin-operator throttle clear --by <who> --reason "<why>"
//
// A password is read from stdin, never from argv (it would land in shell history and `ps`).
import { parseArgs } from 'node:util';

import pg from 'pg';

import { clearThrottle, createUser, resetTotp, revokeSessions, setDisabled, setPassword, status } from '../admin/operator.js';
import { MIN_PASSWORD_LENGTH } from '../admin/password.js';
import { env } from '../config.js';

const USAGE = 'usage: admin-operator status | user add <login> --role OWNER|EDITOR --by <who> | user password <login> --by <who>'
  + ' | user disable|enable <login> --by <who> --reason <why> | totp reset <login> --by <who> --reason <why>'
  + ' | sessions revoke <login> --by <who> --reason <why> | throttle clear --by <who> --reason <why>';

const { positionals, values } = parseArgs({ allowPositionals: true,
  options: { by: { type: 'string' }, reason: { type: 'string' }, role: { type: 'string' } } });
const [group, command, login] = positionals;

async function stdinPassword(): Promise<string> {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk as string;
  const password = raw.replace(/\r?\n$/, '');
  if (password.length < MIN_PASSWORD_LENGTH || password.includes('\n')) {
    throw new Error(`the password on stdin must be one line of at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return password;
}

const need = (...names: ('by' | 'reason' | 'role')[]) => {
  for (const n of names) if (!values[n]) throw new Error(`--${n} is required\n${USAGE}`);
};

const pool = new pg.Pool({ connectionString: env('ADMIN_OPERATOR_DATABASE_URL'), max: 1 });
try {
  if (group === 'status') {
    for (const u of await status(pool)) {
      console.log(`${u.login} ${u.role}${u.disabled ? ' DISABLED' : ''} totp=${u.totp}`
        + `${u.enrolment_until ? ` enrolment-until=${u.enrolment_until.toISOString()}` : ''} sessions=${u.sessions}`);
    }
  } else if (group === 'user' && command === 'add' && login) {
    need('by', 'role');
    if (values.role !== 'OWNER' && values.role !== 'EDITOR') throw new Error('--role is OWNER or EDITOR');
    await createUser(pool, login, values.role, await stdinPassword(), values.by!);
    console.log(`${login} created; enrol the authenticator in the Control Room within 24 hours`);
  } else if (group === 'user' && command === 'password' && login) {
    need('by');
    console.log(`password set; ${await setPassword(pool, login, await stdinPassword(), values.by!)} session(s) revoked`);
  } else if (group === 'user' && (command === 'disable' || command === 'enable') && login) {
    need('by', 'reason');
    console.log(`${login} ${command}d; ${await setDisabled(pool, login, command === 'disable', values.by!, values.reason!)} session(s) revoked`);
  } else if (group === 'totp' && command === 'reset' && login) {
    need('by', 'reason');
    console.log(`TOTP reset; ${await resetTotp(pool, login, values.by!, values.reason!)} session(s) revoked; enrol again within 24 hours`);
  } else if (group === 'sessions' && command === 'revoke' && login) {
    need('by', 'reason');
    console.log(`${await revokeSessions(pool, login, values.by!, values.reason!)} session(s) revoked`);
  } else if (group === 'throttle' && command === 'clear') {
    need('by', 'reason');
    console.log(`${await clearThrottle(pool, values.by!, values.reason!)} throttle bucket(s) cleared`);
  } else {
    throw new Error(USAGE);
  }
} finally {
  await pool.end();
}
