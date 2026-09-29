import type { ListingView } from "@cnote/catalogue";

const grouped = new Intl.NumberFormat("en-IN");

export function moqText(l: Pick<ListingView, "moq" | "moqUnit">): string | null {
  if (l.moq == null) return null;
  return `${grouped.format(l.moq)}${l.moqUnit ? ` ${l.moqUnit}` : ""}`;
}

export function firstParam(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

export function pageParam(v: string | string[] | undefined): number {
  const n = Number.parseInt(firstParam(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 1;
}
