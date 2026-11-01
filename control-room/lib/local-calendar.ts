/** OWNER 2026-11-01: canonical zone for NEW local calendar contracts.
 * Historical accepted snapshots keep their own zone. No dependency on host TZ.
 * This module is shared by SSR and the separately built Admin client.
 */
export const LOCAL_TIME_ZONE = 'Asia/Krasnoyarsk';

export function localCalendarDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: LOCAL_TIME_ZONE }).format(now);
}
