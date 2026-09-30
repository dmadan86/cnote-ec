"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Clock, ShieldAlert } from "lucide-react";
import { Alert, Badge, Card, CardBody, Field, Input, Select, Textarea, buttonClasses } from "@cnote/ui";
import type { CategoryView, ListingView, VersionView } from "@cnote/catalogue";
import { LANGUAGES, UNITS } from "@/lib/constants";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { saveListingAction, type SaveResult } from "./actions";

function Outcome({ version, continueHref, continueLabel }: { version: VersionView | undefined; continueHref: string; continueLabel: string }) {
  const t = useTranslations("listings.editor");
  const rejected = version?.status === "rejected";
  const approved = version?.status === "approved";
  return (
    <Card className={rejected ? "border-red-200" : approved ? "border-green-200" : "border-amber-200"}>
      <CardBody className="space-y-3">
        <div className="flex items-start gap-3">
          {approved ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden /> : rejected ? <ShieldAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden /> : <Clock className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />}
          <div>
            <h2 className="font-semibold text-ink">
              {approved ? t("approvedTitle") : rejected ? t("rejectedTitle") : t("submittedTitle")}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {approved
                ? t("approvedBody")
                : rejected
                  ? t("rejectedBody", { note: version?.reviewNote ?? t("rejectedDefault") })
                  : t("submittedBody")}
            </p>
          </div>
        </div>
        <Link href={continueHref} className={buttonClasses("primary", "lg")}>
          {continueLabel}
        </Link>
      </CardBody>
    </Card>
  );
}

export function ListingEditor({
  listing,
  categories,
  mode,
  defaultLanguage = "en",
}: {
  listing: ListingView | null;
  categories: CategoryView[];
  mode: "onboarding" | "portal";
  defaultLanguage?: string;
}) {
  const t = useTranslations("listings.editor");
  const [state, action] = useActionState<SaveResult | null, FormData>(saveListingAction, null);
  const current = state?.ok ? state.data.listing : listing;
  const [categoryId, setCategoryId] = useState(listing?.category.id ?? categories[0]?.id ?? "");
  const category = categories.find((c) => c.id === categoryId);
  const published = state?.ok && state.data.intent === "publish";

  if (published && current) {
    return <Outcome version={state.data.version} continueHref={mode === "onboarding" ? "/onboarding" : "/listings"} continueLabel={mode === "onboarding" ? t("continue") : t("backToListings")} />;
  }

  const attrs = current?.attributes ?? {};
  return (
    <form action={action} className="space-y-5">
      {current ? <input type="hidden" name="id" value={current.id} /> : null}
      {current?.aiGenerated && current.status === "draft" ? (
        <Alert tone="info">
          <Badge tone="brand" className="mr-2">{t("aiDraftBadge")}</Badge>
          {t("aiDraftNote")}
        </Alert>
      ) : null}
      {state?.ok && state.data.intent === "save" ? <Alert tone="success">{t("saved")}</Alert> : null}

      <Field label={t("category")} htmlFor="categoryId" error={fieldError(state, "categoryId")}>
        <Select id="categoryId" name="categoryId" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="h-11" required>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("title")} htmlFor="title" error={fieldError(state, "title")}>
        <Input id="title" name="title" defaultValue={current?.title ?? ""} required maxLength={140} className="h-11" />
      </Field>
      <Field label={t("description")} htmlFor="description" error={fieldError(state, "description")}>
        <Textarea id="description" name="description" defaultValue={current?.description ?? ""} required className="min-h-32" />
      </Field>

      <fieldset className="space-y-4 rounded-card border border-line bg-surface p-4">
        <legend className="px-1 text-sm font-semibold text-ink">{t("priceLegend")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("price")} htmlFor="priceRupees" hint={t("priceHint")} error={fieldError(state, "priceRupees")}>
            <Input id="priceRupees" name="priceRupees" inputMode="decimal" defaultValue={current?.pricePaise != null ? String(current.pricePaise / 100) : ""} className="h-11" />
          </Field>
          <Field label={t("priceUnit")} htmlFor="priceUnit" error={fieldError(state, "priceUnit")}>
            <Select id="priceUnit" name="priceUnit" defaultValue={current?.priceUnit ?? "pcs"} className="h-11">
              {UNITS.map((u) => <option key={u}>{u}</option>)}
            </Select>
          </Field>
          <Field label={t("moq")} htmlFor="moq" error={fieldError(state, "moq")}>
            <Input id="moq" name="moq" inputMode="numeric" defaultValue={current?.moq ?? ""} className="h-11" />
          </Field>
          <Field label={t("moqUnit")} htmlFor="moqUnit" error={fieldError(state, "moqUnit")}>
            <Select id="moqUnit" name="moqUnit" defaultValue={current?.moqUnit ?? "pcs"} className="h-11">
              {UNITS.map((u) => <option key={u}>{u}</option>)}
            </Select>
          </Field>
        </div>
        <Field label={t("hsn")} htmlFor="hsn" hint={t("hsnHint")} error={fieldError(state, "hsn")}>
          <Input id="hsn" name="hsn" inputMode="numeric" defaultValue={current?.hsn ?? ""} maxLength={8} className="h-11 max-w-xs" />
        </Field>
      </fieldset>

      {category && category.attributeSchema.fields.length > 0 ? (
        <fieldset key={category.id} className="space-y-4 rounded-card border border-line bg-surface p-4">
          <legend className="px-1 text-sm font-semibold text-ink">{t("specs", { category: category.name })}</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {category.attributeSchema.fields.map((f) => {
              const id = `attr-${f.key}`;
              const label = f.unit ? `${f.label} (${f.unit})` : f.label;
              const dv = attrs[f.key] !== undefined ? String(attrs[f.key]) : "";
              return (
                <Field key={f.key} label={f.required ? `${label} *` : label} htmlFor={id} error={fieldError(state, `attr.${f.key}`)}>
                  {f.type === "select" ? (
                    <Select id={id} name={`attr.${f.key}`} defaultValue={dv} className="h-11">
                      <option value="">{t("select")}</option>
                      {(f.options ?? []).map((o) => <option key={o}>{o}</option>)}
                    </Select>
                  ) : (
                    <Input id={id} name={`attr.${f.key}`} defaultValue={dv} inputMode={f.type === "number" ? "decimal" : undefined} className="h-11" />
                  )}
                </Field>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <Field
        label={t("imageLinks")}
        htmlFor="imageUrls"
        hint={t("imageLinksHint")}
        error={fieldError(state, "imageUrls")}
      >
        <Textarea id="imageUrls" name="imageUrls" defaultValue={current?.imageUrls.join("\n") ?? ""} className="min-h-20" placeholder="https://" />
      </Field>
      <Field label={t("language")} htmlFor="language" className="max-w-xs">
        <Select id="language" name="language" defaultValue={current?.language ?? defaultLanguage} className="h-11">
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.native} ({l.label})</option>)}
        </Select>
      </Field>

      {current && current.moderationStatus === "rejected" && current.status === "draft" ? <Alert tone="danger">{current.moderationReason ?? t("rejectedFallback")}</Alert> : null}
      <FormAlert state={state} />

      <div className="flex flex-col gap-3 sm:flex-row">
        <SubmitButton name="intent" value="publish" size="lg" pendingText={t("submitting")}>
          {t("submitBtn")}
        </SubmitButton>
        <SubmitButton name="intent" value="save" variant="outline" size="lg" pendingText={t("saving")}>
          {t("saveBtn")}
        </SubmitButton>
      </div>
      <p className="text-xs text-muted">{t("footnote")}</p>
    </form>
  );
}
