"use client";
// Bill-of-materials editor for the RFQ form (docs/design/rfq-multiline.md): add / remove / reorder lines by keyboard, upload a CSV or
// XLSX, check the column mapping, review the rows. Lines are cards (stacked on mobile, a wrapped grid on desktop) so every control keeps
// a visible label. The editor only produces a hidden `lines` JSON field; createEnquiry validates every line again on the server.
import { Alert, Button, Field, Input, Select, cn } from "@cnote/ui";
import { submitFormAsAction } from "@cnote/next-kit/upload-client";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import {
  BOM_FIELDS, MAX_BOM_LINES, REQUIRED_BOM_FIELDS, applyMapping, emptyRow, moveRow, rowsToLines, validateRow,
  type BomField, type BomMapping, type BomRow,
} from "./bom";

const UNITS = ["pcs", "kg", "ton", "meter", "set", "box", "litre"];

interface Uploaded { headers: string[]; rows: string[][]; mapping: BomMapping; truncated: number; fileName: string }
type Focus = { key: string; target: "item" | "up" | "down" | "remove" } | { key: null; target: "add" } | null;

export function BomEditor({
  categories,
  initialRows,
  fieldErrors,
}: {
  categories: { slug: string; name: string }[];
  initialRows?: Partial<BomRow>[];
  /** server-side error text for the lines field */
  fieldErrors?: string;
}) {
  const t = useTranslations("rfqLines");
  const uid = useId();
  const [rows, setRows] = useState<BomRow[]>(() => (initialRows?.length ? initialRows : [{}]).map((r) => ({ ...emptyRow(), ...r })));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [announce, setAnnounce] = useState("");
  // pending focus target, consumed by the effect after the rows re-render (a ref: setting it must not cause a render)
  const pendingFocus = useRef<Focus>(null);
  const [upload, setUpload] = useState<Uploaded | null>(null);
  const [mapping, setMapping] = useState<BomMapping | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ imported: number; skipped: { row: number; reason: string }[]; clipped: number } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Move focus after a structural change (add / move / remove) so keyboard users keep their place.
  useEffect(() => {
    const focus = pendingFocus.current;
    if (!focus) return;
    pendingFocus.current = null;
    if (focus.target === "add") document.getElementById(`${uid}-add`)?.focus();
    else {
      const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${focus.key}"]`);
      const btn = (a: string) => row?.querySelector<HTMLButtonElement>(`[data-action="${a}"]`) ?? null;
      // A line moved to the top (or bottom) has that arrow disabled, and a disabled button cannot hold focus (it would fall back to
      // <body>): continue with the opposite arrow so a keyboard user keeps their place.
      const opposite = focus.target === "up" ? "down" : focus.target === "down" ? "up" : "item";
      const target = btn(focus.target);
      (target && !target.disabled ? target : btn(opposite))?.focus();
    }
  }, [rows, uid]);

  const patch = (key: string, p: Partial<BomRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const touch = (key: string, field: string) => setTouched((s) => ({ ...s, [`${key}:${field}`]: true }));
  const full = rows.length >= MAX_BOM_LINES;

  const add = () => {
    if (full) return;
    const r = emptyRow();
    setRows((rs) => [...rs, r]);
    pendingFocus.current = { key: r.key, target: "item" };
    setAnnounce(t("added", { n: rows.length + 1 }));
  };
  const remove = (i: number) => {
    if (rows.length <= 1) return;
    const next = rows.filter((_, j) => j !== i);
    setRows(next);
    const nb = next[Math.min(i, next.length - 1)]!;
    pendingFocus.current = { key: nb.key, target: "item" };
    setAnnounce(t("removed", { n: i + 1 }));
  };
  const move = (i: number, to: number) => {
    const moved = rows[i]!;
    setRows(moveRow(rows, i, to));
    pendingFocus.current = { key: moved.key, target: to < i ? "up" : "down" };
    setAnnounce(t("moved", { from: i + 1, to: to + 1 }));
  };

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    setUploadError(null);
    setReport(null);
    if (!file) return;
    if (!/\.(csv|tsv|txt|xlsx)$/i.test(file.name)) return setUploadError(t("errType"));
    if (file.size > 1024 * 1024) return setUploadError(t("errSize"));
    setBusy(true);
    const fd = new FormData();
    fd.set("file", file);
    const res = await submitFormAsAction<{ headers: string[]; rows: string[][]; mapping: BomMapping; truncated: number }>("/api/rfq/bom", fd, { refreshUrl: "/api/me" });
    setBusy(false);
    if (!res.ok) return setUploadError(res.error);
    setUpload({ ...res.data, fileName: file.name });
    setMapping(res.data.mapping);
  }

  function runImport(mode: "append" | "replace") {
    if (!upload || !mapping) return;
    const blank = (r: BomRow) => !r.itemName.trim() && !r.quantity.trim() && !r.spec.trim();
    const kept = mode === "replace" ? [] : rows.filter((r) => !blank(r));
    const result = applyMapping(upload.rows, mapping, categories, 2, MAX_BOM_LINES - kept.length);
    const next = [...kept, ...result.rows];
    setRows(next.length ? next : [emptyRow()]);
    setReport({ imported: result.rows.length, skipped: result.skipped, clipped: result.clipped + upload.truncated });
    setAnnounce(t("imported", { count: result.rows.length }));
    setUpload(null);
    setMapping(null);
  }

  const missing = mapping ? REQUIRED_BOM_FIELDS.filter((f) => mapping[f] === null) : [];
  const lines = rowsToLines(rows);

  return (
    <div className="flex flex-col gap-4" data-testid="bom-editor">
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      {fieldErrors ? <p role="alert" className="text-xs text-danger">{fieldErrors}</p> : null}

      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
        <p className="text-sm font-semibold text-ink">{t("uploadTitle")}</p>
        <p className="text-xs text-muted" id={`${uid}-upload-hint`}>{t("uploadHint", { max: MAX_BOM_LINES })}</p>
        <div className="flex flex-wrap items-center gap-3">
          <label className={cn("inline-flex min-h-11 cursor-pointer items-center rounded-full border border-brand-600 bg-surface px-4 text-sm font-semibold text-brand-700 hover:bg-brand-50", "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-600", busy && "pointer-events-none opacity-50")}>
            {busy ? t("reading") : t("chooseFile")}
            <input type="file" accept=".csv,.tsv,.txt,.xlsx" className="sr-only" onChange={onFile} aria-describedby={`${uid}-upload-hint`} disabled={busy} />
          </label>
          <a href="/api/rfq/bom" download className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline underline-offset-2">{t("template")}</a>
        </div>
        {uploadError ? <Alert tone="danger">{uploadError}</Alert> : null}
        {report ? (
          <div className="text-sm" role="status">
            <p className="font-medium text-ink">{t("imported", { count: report.imported })}</p>
            {report.clipped > 0 ? <p className="text-muted">{t("clipped", { count: report.clipped, max: MAX_BOM_LINES })}</p> : null}
            {report.skipped.length ? (
              <details className="mt-1">
                <summary className="min-h-11 cursor-pointer py-2 text-muted">{t("skippedSummary", { count: report.skipped.length })}</summary>
                <ul className="list-disc pl-5 text-muted">
                  {report.skipped.slice(0, 20).map((s, i) => (
                    <li key={`${s.row}-${i}`}>{t("skippedRow", { row: s.row, reason: t(`skip.${s.reason}`) })}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}

        {upload && mapping ? (
          <div className="mt-2 flex flex-col gap-3 rounded-lg border border-brand-600 p-3" role="group" aria-labelledby={`${uid}-map-title`}>
            <p id={`${uid}-map-title`} className="text-sm font-semibold text-ink">{t("mapTitle", { file: upload.fileName })}</p>
            <p className="text-xs text-muted">{t("mapHint", { count: upload.rows.length })}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {BOM_FIELDS.map((f: BomField) => (
                <Field key={f} label={`${t(`field.${f}`)}${REQUIRED_BOM_FIELDS.includes(f) ? " *" : ""}`} htmlFor={`${uid}-map-${f}`}>
                  <Select id={`${uid}-map-${f}`} value={mapping[f] === null ? "" : String(mapping[f])} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === "" ? null : Number(e.target.value) })}>
                    <option value="">{t("mapNone")}</option>
                    {upload.headers.map((h, i) => (
                      <option key={i} value={i}>{h || t("mapColumn", { n: i + 1 })}{upload.rows[0]?.[i] ? ` (${upload.rows[0][i]!.slice(0, 24)})` : ""}</option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
            {missing.length ? <Alert tone="warning">{t("mapMissing", { fields: missing.map((f) => t(`field.${f}`)).join(", ") })}</Alert> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="primary" disabled={missing.length > 0} onClick={() => runImport("append")}>{t("importAppend")}</Button>
              <Button type="button" variant="outline" disabled={missing.length > 0} onClick={() => runImport("replace")}>{t("importReplace")}</Button>
              <Button type="button" variant="ghost" onClick={() => { setUpload(null); setMapping(null); }}>{t("cancel")}</Button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="text-sm text-muted" aria-live="polite" data-testid="bom-count">{t("count", { count: rows.length, max: MAX_BOM_LINES })}</p>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      <ol ref={listRef} className="flex flex-col gap-4" aria-label={t("listLabel")}>
        {rows.map((r, i) => {
          const errs = validateRow(r);
          const err = (field: string) => (touched[`${r.key}:${field}`] ? errs.find((x) => x.field === field) : undefined);
          const msg = (field: string) => { const e = err(field); return e ? t(`err.${e.code}`) : undefined; };
          const id = (n: string) => `${uid}-${r.key}-${n}`;
          return (
            <li key={r.key} data-row={r.key}>
              <fieldset className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
                <legend className="px-1 text-sm font-semibold text-ink">{t("lineN", { n: i + 1 })}</legend>
                <div className="grid gap-3 sm:grid-cols-6">
                  <Field className="sm:col-span-4" label={`${t("field.itemName")} *`} htmlFor={id("item")} error={msg("itemName")}>
                    <Input id={id("item")} data-action="item" value={r.itemName} maxLength={140} required onChange={(e) => patch(r.key, { itemName: e.target.value })} onBlur={() => touch(r.key, "itemName")} />
                  </Field>
                  <Field className="sm:col-span-2" label={`${t("field.quantity")} *`} htmlFor={id("qty")} error={msg("quantity")}>
                    <Input id={id("qty")} inputMode="numeric" value={r.quantity} required onChange={(e) => patch(r.key, { quantity: e.target.value })} onBlur={() => touch(r.key, "quantity")} />
                  </Field>
                  <Field className="sm:col-span-6" label={t("field.spec")} htmlFor={id("spec")}>
                    <Input id={id("spec")} value={r.spec} maxLength={1000} onChange={(e) => patch(r.key, { spec: e.target.value })} />
                  </Field>
                  <Field className="sm:col-span-2" label={`${t("field.unit")} *`} htmlFor={id("unit")} error={msg("unit")}>
                    <Input id={id("unit")} list={`${uid}-units`} value={r.unit} maxLength={20} required onChange={(e) => patch(r.key, { unit: e.target.value })} onBlur={() => touch(r.key, "unit")} />
                  </Field>
                  <Field className="sm:col-span-2" label={t("field.targetPrice")} htmlFor={id("price")} error={msg("targetPrice")}>
                    <Input id={id("price")} inputMode="decimal" value={r.targetPrice} onChange={(e) => patch(r.key, { targetPrice: e.target.value })} onBlur={() => touch(r.key, "targetPrice")} />
                  </Field>
                  <Field className="sm:col-span-2" label={t("field.hsn")} htmlFor={id("hsn")} error={msg("hsn")}>
                    <Input id={id("hsn")} inputMode="numeric" maxLength={8} value={r.hsn} onChange={(e) => patch(r.key, { hsn: e.target.value.replace(/\D/g, "") })} onBlur={() => touch(r.key, "hsn")} />
                  </Field>
                  {categories.length ? (
                    <Field className="sm:col-span-6" label={t("field.category")} htmlFor={id("cat")}>
                      <Select id={id("cat")} value={r.categorySlug} onChange={(e) => patch(r.key, { categorySlug: e.target.value })}>
                        <option value="">{t("noCategory")}</option>
                        {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                      </Select>
                    </Field>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" data-action="up" disabled={i === 0} aria-label={t("moveUp", { n: i + 1 })} onClick={() => move(i, i - 1)}>
                    <span aria-hidden>↑</span> {t("up")}
                  </Button>
                  <Button type="button" size="sm" variant="outline" data-action="down" disabled={i === rows.length - 1} aria-label={t("moveDown", { n: i + 1 })} onClick={() => move(i, i + 1)}>
                    <span aria-hidden>↓</span> {t("down")}
                  </Button>
                  <Button type="button" size="sm" variant="outline" data-action="remove" disabled={rows.length <= 1} aria-label={t("remove", { n: i + 1 })} onClick={() => remove(i)}>
                    <span aria-hidden>×</span> {t("removeShort")}
                  </Button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <datalist id={`${uid}-units`}>{UNITS.map((u) => <option key={u} value={u} />)}</datalist>

      <div>
        <Button id={`${uid}-add`} type="button" variant="outline-brand" disabled={full} onClick={add}>{t("add")}</Button>
        {full ? <p className="mt-1 text-xs text-muted">{t("full", { max: MAX_BOM_LINES })}</p> : null}
      </div>
    </div>
  );
}
