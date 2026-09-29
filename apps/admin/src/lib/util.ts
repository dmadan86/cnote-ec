export const fmtDate = (iso: string | Date) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

export const shortId = (id: string) => id.slice(0, 8);

/** Run a module read; degrade to `null` (and log) when the module is unavailable or not yet implemented. */
export async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[admin] ${label} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim() : undefined;
}

export function json(v: unknown, max = 4000): string {
  const s = JSON.stringify(v, null, 2) ?? "";
  return s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s;
}
