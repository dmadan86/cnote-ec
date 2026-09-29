import "server-only";

/** Structured log line (one JSON object). Picked up by the log pipeline; ADR-004 time-to-first-listing metric. */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ ts: new Date().toISOString(), app: "seller", event, ...fields }));
}
