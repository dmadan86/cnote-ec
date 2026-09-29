const dt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const d = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export function formatDateTime(iso: string): string {
  return dt.format(new Date(iso));
}
export function formatDate(iso: string): string {
  return d.format(new Date(iso));
}
