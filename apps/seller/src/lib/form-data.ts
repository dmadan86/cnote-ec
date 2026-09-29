/** FormData helpers for server actions. */
export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}
export function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}
/** Empty string -> null, otherwise Number (NaN for junk so zod can reject it). */
export function numOrNull(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  return v === "" ? null : Number(v);
}
