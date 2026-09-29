"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { CheckCircle2, Clock, ShieldAlert } from "lucide-react";
import { Alert, Badge, Card, CardBody, Field, Input, Select, Textarea, buttonClasses } from "@cnote/ui";
import type { CategoryView, ListingView, VersionView } from "@cnote/catalogue";
import { LANGUAGES, UNITS } from "@/lib/constants";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { saveListingAction, type SaveResult } from "./actions";

function Outcome({ version, continueHref, continueLabel }: { version: VersionView | undefined; continueHref: string; continueLabel: string }) {
  const rejected = version?.status === "rejected";
  const approved = version?.status === "approved";
  return (
    <Card className={rejected ? "border-red-200" : approved ? "border-green-200" : "border-amber-200"}>
      <CardBody className="space-y-3">
        <div className="flex items-start gap-3">
          {approved ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden /> : rejected ? <ShieldAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden /> : <Clock className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />}
          <div>
            <h2 className="font-semibold text-ink">
              {approved ? "Approved: going live shortly" : rejected ? "We could not accept this version" : "Submitted for review"}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {approved
                ? "Your version passed the checks and is being published. Buyers will find it within a minute or so."
                : rejected
                  ? (version?.reviewNote ?? "It appears to break the marketplace policy.") + " You can edit it and submit again, or contact us to appeal."
                  : "Our team is checking it against the marketplace policy. It goes live automatically once approved. Anything already live stays unchanged meanwhile."}
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
  const [state, action] = useActionState<SaveResult | null, FormData>(saveListingAction, null);
  const current = state?.ok ? state.data.listing : listing;
  const [categoryId, setCategoryId] = useState(listing?.category.id ?? categories[0]?.id ?? "");
  const category = categories.find((c) => c.id === categoryId);
  const published = state?.ok && state.data.intent === "publish";

  if (published && current) {
    return <Outcome version={state.data.version} continueHref={mode === "onboarding" ? "/onboarding" : "/listings"} continueLabel={mode === "onboarding" ? "Continue" : "Back to listings"} />;
  }

  const attrs = current?.attributes ?? {};
  return (
    <form action={action} className="space-y-5">
      {current ? <input type="hidden" name="id" value={current.id} /> : null}
      {current?.aiGenerated && current.status === "draft" ? (
        <Alert tone="info">
          <Badge tone="brand" className="mr-2">AI draft</Badge>
          AI draft, check before submitting. Fix anything that is wrong: price, minimum order and specs matter most to buyers.
        </Alert>
      ) : null}
      {state?.ok && state.data.intent === "save" ? <Alert tone="success">Saved to your working copy. Buyers see nothing new until you submit it for review.</Alert> : null}

      <Field label="Category" htmlFor="categoryId" error={fieldError(state, "categoryId")}>
        <Select id="categoryId" name="categoryId" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="h-11" required>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Title" htmlFor="title" error={fieldError(state, "title")}>
        <Input id="title" name="title" defaultValue={current?.title ?? ""} required maxLength={140} className="h-11" />
      </Field>
      <Field label="Description" htmlFor="description" error={fieldError(state, "description")}>
        <Textarea id="description" name="description" defaultValue={current?.description ?? ""} required className="min-h-32" />
      </Field>

      <fieldset className="space-y-4 rounded-card border border-line bg-surface p-4">
        <legend className="px-1 text-sm font-semibold text-ink">Price and minimum order</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Price (₹)" htmlFor="priceRupees" hint="Per unit. Leave blank to show 'Ask for price'." error={fieldError(state, "priceRupees")}>
            <Input id="priceRupees" name="priceRupees" inputMode="decimal" defaultValue={current?.pricePaise != null ? String(current.pricePaise / 100) : ""} className="h-11" />
          </Field>
          <Field label="Price per" htmlFor="priceUnit" error={fieldError(state, "priceUnit")}>
            <Select id="priceUnit" name="priceUnit" defaultValue={current?.priceUnit ?? "pcs"} className="h-11">
              {UNITS.map((u) => <option key={u}>{u}</option>)}
            </Select>
          </Field>
          <Field label="Minimum order quantity" htmlFor="moq" error={fieldError(state, "moq")}>
            <Input id="moq" name="moq" inputMode="numeric" defaultValue={current?.moq ?? ""} className="h-11" />
          </Field>
          <Field label="MOQ unit" htmlFor="moqUnit" error={fieldError(state, "moqUnit")}>
            <Select id="moqUnit" name="moqUnit" defaultValue={current?.moqUnit ?? "pcs"} className="h-11">
              {UNITS.map((u) => <option key={u}>{u}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="HSN code (optional)" htmlFor="hsn" hint="4, 6 or 8 digits. It helps match your listing to your GST." error={fieldError(state, "hsn")}>
          <Input id="hsn" name="hsn" inputMode="numeric" defaultValue={current?.hsn ?? ""} maxLength={8} className="h-11 max-w-xs" />
        </Field>
      </fieldset>

      {category && category.attributeSchema.fields.length > 0 ? (
        <fieldset key={category.id} className="space-y-4 rounded-card border border-line bg-surface p-4">
          <legend className="px-1 text-sm font-semibold text-ink">Specifications for {category.name}</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {category.attributeSchema.fields.map((f) => {
              const id = `attr-${f.key}`;
              const label = f.unit ? `${f.label} (${f.unit})` : f.label;
              const dv = attrs[f.key] !== undefined ? String(attrs[f.key]) : "";
              return (
                <Field key={f.key} label={f.required ? `${label} *` : label} htmlFor={id} error={fieldError(state, `attr.${f.key}`)}>
                  {f.type === "select" ? (
                    <Select id={id} name={`attr.${f.key}`} defaultValue={dv} className="h-11">
                      <option value="">Select…</option>
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
        label="Image links (optional)"
        htmlFor="imageUrls"
        hint="One https:// link per line, up to 5. Photo upload is coming soon; for now paste links to photos you already host."
        error={fieldError(state, "imageUrls")}
      >
        <Textarea id="imageUrls" name="imageUrls" defaultValue={current?.imageUrls.join("\n") ?? ""} className="min-h-20" placeholder="https://" />
      </Field>
      <Field label="Listing language" htmlFor="language" className="max-w-xs">
        <Select id="language" name="language" defaultValue={current?.language ?? defaultLanguage} className="h-11">
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.native} ({l.label})</option>)}
        </Select>
      </Field>

      {current && current.moderationStatus === "rejected" && current.status === "draft" ? <Alert tone="danger">{current.moderationReason ?? "This listing was rejected by the policy check."}</Alert> : null}
      <FormAlert state={state} />

      <div className="flex flex-col gap-3 sm:flex-row">
        <SubmitButton name="intent" value="publish" size="lg" pendingText="Submitting…">
          Save and submit for review
        </SubmitButton>
        <SubmitButton name="intent" value="save" variant="outline" size="lg" pendingText="Saving…">
          Save as draft
        </SubmitButton>
      </div>
      <p className="text-xs text-muted">Every version, including AI drafts, is checked against our prohibited-category policy and is reviewed before it goes live.</p>
    </form>
  );
}
