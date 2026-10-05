// Sample workflow configuration (docs/design/samples.md). Read per call so tests and ops can flip env without a restart.

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Flag SAMPLES_ENABLED: default OFF until the seller side is rolled out. */
export function samplesEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SAMPLES_ENABLED ?? "");
}

function num(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= min ? n : fallback;
}

export interface SampleConfig {
  /** Seller SLA: respond within this many hours, else the request auto-expires (default 48). */
  responseHours: number;
  /** Abuse guard: open (requested/accepted/dispatched/delivered) requests one buyer business may hold at once. */
  maxOpenPerBuyer: number;
  /** Abuse guard: new requests one person may create per 24h. */
  requestsPerDay: number;
  /** Quantity cap when the listing sets none. */
  defaultMaxQty: number;
  /** Sample approval rate is shown only from this many evaluated samples (small samples mislead). */
  minEvaluatedForRate: number;
}

export function sampleConfig(): SampleConfig {
  return {
    responseHours: num("SAMPLES_RESPONSE_HOURS", 48, 1),
    maxOpenPerBuyer: Math.floor(num("SAMPLES_MAX_OPEN_PER_BUYER", 5, 1)),
    requestsPerDay: Math.floor(num("SAMPLES_REQUESTS_PER_DAY", 10, 1)),
    defaultMaxQty: Math.floor(num("SAMPLES_DEFAULT_MAX_QTY", 20, 1)),
    minEvaluatedForRate: Math.floor(num("SAMPLES_MIN_EVALUATED_FOR_RATE", 5, 1)),
  };
}

/** DPDP: ship-to details, notes and evaluation photos are removed this long after a request reached a final status. */
export const SAMPLE_RETENTION_DAYS = 365;
