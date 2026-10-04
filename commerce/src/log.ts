// Structured logs WITHOUT personal data (docs/DECISIONS.md #9). A field is a closed type: an order
// reference, a code, a count. Names, phones, emails and dates of birth are never passed here; the
// order tests capture every line written during a booking and look for them.

export type LogValue = string | number | boolean | null;
export type Logger = (event: string, fields?: Readonly<Record<string, LogValue>>) => void;

export const jsonLogger = (service: string): Logger => (event, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), service, event, ...fields })}\n`);
};
