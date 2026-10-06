// Operator-tunable timings (env read lazily; documented in .env.example).
const int = (name: string, dflt: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : dflt;
};

const HOUR_MS = 3_600_000;
/** SLA for one level: after this the approvers get a reminder, then another every SLA window. */
export const slaMs = () => int("APPROVAL_SLA_HOURS", 24) * HOUR_MS;
export const maxReminders = () => int("APPROVAL_MAX_REMINDERS", 3);
/** A request nobody decides within this many days expires (the held action is dropped, the requester told). */
export const expiryMs = () => int("APPROVAL_EXPIRY_DAYS", 7) * 24 * HOUR_MS;
