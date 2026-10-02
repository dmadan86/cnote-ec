"use client";
import type { EnquiryView } from "@cnote/enquiry";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState, useSyncExternalStore } from "react";
import { PINCODE_COOKIE } from "@/features/shell/site";
import { postRfqAction } from "./actions";
import { RfqResult } from "./rfq-result";
import { trustLabels } from "./trust-labels";

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ACCEPT_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const EXPIRY_DAYS = [1, 3, 7, 14, 30];

const noopSubscribe = () => () => undefined;
export function readPincodeCookie(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${PINCODE_COOKIE}=(\\d{6})`));
  return m ? m[1]! : null;
}

/** Client-side mirror of the server's checks (the server re-validates by magic bytes). Returns an error key + file name, or null. */
export function validateFiles(files: { name: string; type: string; size: number }[]): { key: "errTooMany" | "errType" | "errSize"; name?: string } | null {
  if (files.length > MAX_FILES) return { key: "errTooMany" };
  for (const f of files) {
    if (!ACCEPT_TYPES.includes(f.type)) return { key: "errType", name: f.name };
    if (f.size > MAX_FILE_BYTES) return { key: "errSize", name: f.name };
  }
  return null;
}

function AttachmentsField({ error }: { error?: string }) {
  const t = useTranslations("rfq2");

  const [files, setFiles] = useState<File[]>([]);
  const [clientError, setClientError] = useState<string | null>(null);
  const sync = (next: File[]) => {
    const input = document.getElementById("attachments") as HTMLInputElement | null;
    if (!input) return;
    const dt = new DataTransfer();
    next.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    setFiles(next);
  };
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    const bad = validateFiles(picked);
    if (bad) {
      setClientError(t(bad.key, { name: bad.name ?? "" }));
      sync([]);
      return;
    }
    setClientError(null);
    setFiles(picked);
  };
  return (
    <div className="flex flex-col gap-2">
      <Field label={t("attachments")} htmlFor="attachments" hint={t("attachmentsHint")} error={clientError ?? error}>
        <Input
          id="attachments"
          name="attachments"
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          onChange={onChange}
          className="h-auto min-h-11 py-2"
        />
      </Field>
      <p className="text-xs text-muted" aria-live="polite">{files.length ? t("attachmentsSelected", { count: files.length }) : ""}</p>
      {files.length ? (
        <ul className="flex flex-col gap-1.5">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm">
              <span className="min-w-0 truncate text-ink">{f.name}</span>
              <button
                type="button"
                className="min-h-11 min-w-11 shrink-0 px-2 text-base font-semibold text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600"
                aria-label={t("removeFile", { name: f.name })}
                onClick={() => sync(files.filter((_, j) => j !== i))}
              >
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const UNITS = ["pcs", "kg", "ton", "meter", "set", "box", "litre"];
const UNIT_ALIASES: Record<string, string> = { piece: "pcs", pieces: "pcs", meters: "meter", metre: "meter", boxes: "box", litres: "litre", tons: "ton", sets: "set" };
/** Listing units ("piece", "meters", ...) mapped onto the RFQ unit list; unknown units fall back to pcs. */
export function rfqUnit(u: string | undefined): string {
  const k = (u ?? "").trim().toLowerCase();
  const v = UNIT_ALIASES[k] ?? k;
  return UNITS.includes(v) ? v : "pcs";
}

export interface RfqFormProps {
  categories: { slug: string; name: string }[];
  defaults?: { title?: string; requirement?: string; categorySlug?: string; preferredListingId?: string; preferredSellerId?: string; quantity?: number; unit?: string; targetPriceRupees?: string };
}

export function RfqForm({ categories, defaults }: RfqFormProps) {
  const t = useTranslations("rfq");
  const tb = useTranslations("buyer");
  const t2 = useTranslations("rfq2");
  const tc = useTranslations("cards");
  const tierLabels = trustLabels(tc).tiers;
  // "Deliver to" pincode (cnote_pincode, non-httpOnly) prefills the delivery pincode; once the buyer types, their value wins.
  const cookiePin = useSyncExternalStore(noopSubscribe, readPincodeCookie, () => null);
  const [typedPin, setTypedPin] = useState<string | null>(null);
  const pincode = typedPin ?? cookiePin ?? "";
  const [state, action, pending] = useActionState<ActionResult<EnquiryView> | null, FormData>(postRfqAction, null);
  if (state?.ok) return <RfqResult enquiry={state.data} />;
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      {defaults?.preferredListingId ? <input type="hidden" name="preferredListingId" value={defaults.preferredListingId} /> : null}
      {defaults?.preferredSellerId ? <input type="hidden" name="preferredSellerId" value={defaults.preferredSellerId} /> : null}

      <Field label={t("whatYouNeed")} htmlFor="title" error={err("title")} hint={t("whatYouNeedHint")}>
        <Input id="title" name="title" required maxLength={140} defaultValue={defaults?.title} aria-invalid={!!err("title")} />
      </Field>
      <Field label={t("details")} htmlFor="requirement" error={err("requirement")} hint={t("detailsHint")}>
        <Textarea id="requirement" name="requirement" required rows={5} maxLength={4000} defaultValue={defaults?.requirement} aria-invalid={!!err("requirement")} />
      </Field>
      <Field label={t("category")} htmlFor="categorySlug" error={err("categorySlug")} hint={t("categoryHint")}>
        <Select id="categorySlug" name="categorySlug" defaultValue={defaults?.categorySlug ?? ""}>
          <option value="">{t("notSure")}</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("quantity")} htmlFor="quantity" error={err("quantity")}>
          <Input id="quantity" name="quantity" type="number" inputMode="numeric" min={1} step={1} defaultValue={defaults?.quantity} />
        </Field>
        <Field label={t("unit")} htmlFor="quantityUnit" error={err("quantityUnit")}>
          <Select id="quantityUnit" name="quantityUnit" defaultValue={rfqUnit(defaults?.unit)}>
            {UNITS.map((u) => (
              <option key={u} value={u}>{tb(`unit.${u}`)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("targetPrice")} htmlFor="targetPrice" error={err("targetPricePaise")} hint={t("optional")}>
          <Input id="targetPrice" name="targetPrice" type="number" inputMode="decimal" min={0} step="0.01" defaultValue={defaults?.targetPriceRupees} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("deliveryCity")} htmlFor="deliveryCity" error={err("deliveryCity")}>
          <Input id="deliveryCity" name="deliveryCity" autoComplete="address-level2" />
        </Field>
        <Field label={t("pincode")} htmlFor="deliveryPincode" error={err("deliveryPincode")} hint={t2("pincodeHint")}>
          <Input id="deliveryPincode" name="deliveryPincode" inputMode="numeric" maxLength={6} autoComplete="postal-code" value={pincode} onChange={(e) => setTypedPin(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Field label={t("neededBy")} htmlFor="neededBy" error={err("neededBy")} hint={t2("requiredByHint")}>
          <Input id="neededBy" name="neededBy" type="date" />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-4 rounded-lg border border-line p-4">
        <legend className="px-1 text-sm font-semibold text-ink">{t2("optionalDetails")}</legend>
        <p className="text-xs text-muted">{t2("optionalDetailsHint")}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t2("budgetMin")} htmlFor="budgetMin" error={err("budgetMinPaise")} hint={t2("budgetHint")}>
            <Input id="budgetMin" name="budgetMin" type="number" inputMode="decimal" min={0} step="0.01" />
          </Field>
          <Field label={t2("budgetMax")} htmlFor="budgetMax" error={err("budgetMaxPaise")}>
            <Input id="budgetMax" name="budgetMax" type="number" inputMode="decimal" min={0} step="0.01" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t2("expiry")} htmlFor="expiresInDays" error={err("expiresInDays")} hint={t2("expiryHint")}>
            <Select id="expiresInDays" name="expiresInDays" defaultValue="7">
              {EXPIRY_DAYS.map((d) => (
                <option key={d} value={d}>{t2("expiryDays", { days: d })}</option>
              ))}
            </Select>
          </Field>
          <Field label={t2("minTier")} htmlFor="minSellerTier" error={err("minSellerTier")} hint={t2("minTierHint")}>
            <Select id="minSellerTier" name="minSellerTier" defaultValue="">
              <option value="">{t2("tierAny")}</option>
              {[1, 2, 3].map((tier) => (
                <option key={tier} value={tier}>{t2("tierOrHigher", { label: tierLabels[tier] ?? String(tier) })}</option>
              ))}
            </Select>
          </Field>
        </div>
        <AttachmentsField error={err("attachments")} />
      </fieldset>

      <label className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3 text-sm">
        <input type="checkbox" name="buyerPicks" className="mt-0.5 size-4 accent-brand-600" />
        <span>
          <span className="font-medium text-ink">{t("pickSellers")}</span>
          <span className="block text-muted">{t("pickSellersHint")}</span>
        </span>
      </label>

      <p className="text-xs text-muted">
        {t("privacy")}
      </p>
      <div>
        <Button type="submit" variant="accent" size="lg" disabled={pending}>
          {pending ? t("posting") : t("submit")}
        </Button>
      </div>
    </form>
  );
}
