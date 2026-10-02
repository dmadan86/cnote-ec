// DPDP s.11 right of access (ADR-010, security audit M10). Every module that holds personal data exposes
// `exportPersonalData(personId, ctx)` from its public API; @cnote/compliance's export registry calls them (like the retention
// registry calls each module's purge function), so no module reads another module's tables.

/** Max rows returned per collection by one module's export. The result flags `truncated` instead of growing without bound. */
export const EXPORT_ROW_CAP = 5000;

/** What the registry already knows about the person, so a module need not query identity's tables. */
export interface PersonalExportContext {
  /** Businesses the person is a member of (buyer and seller are roles on a Business). */
  businessIds: string[];
}

export type PersonalExport = Record<string, unknown>;
export type PersonalExporter = (personId: string, ctx: PersonalExportContext) => Promise<PersonalExport>;

/** `take` value for a capped query: one extra row tells us whether the collection was cut. */
export const EXPORT_TAKE = EXPORT_ROW_CAP + 1;

/** Applies the cap to a query result fetched with `take: EXPORT_TAKE`. */
export function capRows<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return rows.length > EXPORT_ROW_CAP ? { rows: rows.slice(0, EXPORT_ROW_CAP), truncated: true } : { rows, truncated: false };
}

/** `{ items, truncated }` shape used for every capped collection in an export. */
export function exportCollection<T>(fetched: T[]): { items: T[]; truncated: boolean } {
  const { rows, truncated } = capRows(fetched);
  return { items: rows, truncated };
}
