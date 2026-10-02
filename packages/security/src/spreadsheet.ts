// Spreadsheet formula-injection guard (CSV / XLSX exports). A text cell starting with = + - @ tab or CR is run as a
// formula by Excel/Sheets/LibreOffice (e.g. =HYPERLINK(...), DDE), so exports prefix it with a single quote.
// Numbers are never touched (a negative number is not an attack and must stay numeric).

export const FORMULA_START = /^[=+\-@\t\r]/;

/** Neutralises one text cell. Non-strings are returned unchanged. */
export function neutraliseFormula<T>(v: T): T | string {
  return typeof v === "string" && FORMULA_START.test(v) ? `'${v}` : v;
}

/** Inverse for files we exported ourselves and are now re-importing: drops the guard quote in front of a formula start. */
export function restoreNeutralised(v: string): string {
  return v.length > 1 && v[0] === "'" && FORMULA_START.test(v.slice(1)) ? v.slice(1) : v;
}
