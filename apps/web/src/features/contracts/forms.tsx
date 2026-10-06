"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState, useId, useRef, useState } from "react";
import { callOffAction, createContractAction, proposeAction, renewAction, respondAction, sendAction, terminateAction, updateDraftAction } from "./actions";

type State = ActionResult | null;
const GST_PERCENTS = [0, 3, 5, 12, 18, 28, 40];
const BASES = ["ex_works", "for_destination", "delivered", "other"] as const;

function Result({ state, ok }: { state: State; ok?: string }) {
  if (!state) return null;
  return state.ok ? (ok ? <Alert tone="success">{ok}</Alert> : null) : <Alert tone="danger">{state.error}</Alert>;
}

export interface ItemDefaults {
  itemKey?: string;
  listingId?: string | null;
  description: string;
  hsn: string;
  unit: string;
  /** rupees */
  price: string;
  gstPercent: number;
  moq: string;
  quantityCap: string;
  variationKind: "fixed" | "indexed";
  /** percent */
  variationCapPercent: string;
  variationNote: string;
}

export interface TermsDefaults {
  title: string;
  validFrom: string;
  validTo: string;
  paymentTermsDays: string;
  priceBasis: (typeof BASES)[number];
  /** rupees */
  valueCap: string;
  notes: string;
  items: ItemDefaults[];
}

export const EMPTY_ITEM: ItemDefaults = { description: "", hsn: "", unit: "", price: "", gstPercent: 18, moq: "", quantityCap: "", variationKind: "fixed", variationCapPercent: "", variationNote: "" };

function ItemRow({ n, d, canRemove, onRemove, scope }: { n: number; d: ItemDefaults; canRemove: boolean; onRemove: () => void; scope: string }) {
  const t = useTranslations("contracts");
  const [kind, setKind] = useState(d.variationKind);
  const id = `${scope}-i${n}`;
  const name = (k: string) => `items.${n}.${k}`;
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <legend className="px-1 text-sm font-semibold text-ink">{t("form.itemLegend", { n: n + 1 })}</legend>
      {d.itemKey ? <input type="hidden" name={name("itemKey")} value={d.itemKey} /> : null}
      {d.listingId ? <input type="hidden" name={name("listingId")} value={d.listingId} /> : null}
      <Field label={t("form.itemDescription")} htmlFor={`${id}-desc`}>
        <Input id={`${id}-desc`} name={name("description")} required minLength={2} maxLength={300} defaultValue={d.description} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label={t("form.unit")} htmlFor={`${id}-unit`}>
          <Input id={`${id}-unit`} name={name("unit")} required maxLength={32} defaultValue={d.unit} />
        </Field>
        <Field label={t("form.price")} htmlFor={`${id}-price`} hint={t("form.priceHint")}>
          <Input id={`${id}-price`} name={name("price")} type="number" inputMode="decimal" min={0.01} step={0.01} required defaultValue={d.price} />
        </Field>
        <Field label={t("form.gst")} htmlFor={`${id}-gst`}>
          <Select id={`${id}-gst`} name={name("gstPercent")} defaultValue={String(d.gstPercent)}>
            {GST_PERCENTS.map((p) => <option key={p} value={p}>{p}%</option>)}
          </Select>
        </Field>
        <Field label={t("form.hsn")} htmlFor={`${id}-hsn`}>
          <Input id={`${id}-hsn`} name={name("hsn")} inputMode="numeric" pattern="[0-9]{2,8}" maxLength={8} autoComplete="off" defaultValue={d.hsn} />
        </Field>
        <Field label={t("form.moq")} htmlFor={`${id}-moq`} hint={t("form.moqHint")}>
          <Input id={`${id}-moq`} name={name("moq")} type="number" inputMode="numeric" min={1} step={1} defaultValue={d.moq} />
        </Field>
        <Field label={t("form.quantityCap")} htmlFor={`${id}-cap`} hint={t("form.quantityCapHint")}>
          <Input id={`${id}-cap`} name={name("quantityCap")} type="number" inputMode="numeric" min={1} step={1} defaultValue={d.quantityCap} />
        </Field>
        <Field label={t("form.variation")} htmlFor={`${id}-var`}>
          <Select id={`${id}-var`} name={name("variationKind")} value={kind} onChange={(e) => setKind(e.target.value === "indexed" ? "indexed" : "fixed")}>
            <option value="fixed">{t("variation.fixed")}</option>
            <option value="indexed">{t("variation.indexed")}</option>
          </Select>
        </Field>
      </div>
      {kind === "indexed" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("form.variationCap")} htmlFor={`${id}-vcap`} hint={t("form.variationCapHint")}>
            <Input id={`${id}-vcap`} name={name("variationCapPercent")} type="number" inputMode="decimal" min={0.01} max={50} step={0.01} required defaultValue={d.variationCapPercent} />
          </Field>
          <Field label={t("form.variationNote")} htmlFor={`${id}-vnote`} hint={t("form.variationNoteHint")} className="sm:col-span-2">
            <Input id={`${id}-vnote`} name={name("variationNote")} required minLength={3} maxLength={300} defaultValue={d.variationNote} />
          </Field>
        </div>
      ) : null}
      {canRemove ? (
        <div>
          <Button type="button" variant="outline" onClick={onRemove}>{t("form.removeItem", { n: n + 1 })}</Button>
        </div>
      ) : null}
    </fieldset>
  );
}

/** Terms editor shared by: new contract, editing a draft, and proposing a revision. */
export function TermsForm(props: {
  mode: "create" | "draft" | "revise";
  contractId?: string;
  quoteId?: string;
  suppliers?: { businessId: string; name: string }[];
  supplierId?: string;
  defaults: TermsDefaults;
  today: string;
}) {
  const t = useTranslations("contracts");
  const action = props.mode === "create" ? createContractAction : props.mode === "draft" ? updateDraftAction : proposeAction;
  const [state, act, pending] = useActionState<State, FormData>(action, null);
  const scope = useId().replace(/:/g, "");
  const next = useRef(props.defaults.items.length);
  const [rows, setRows] = useState(() => props.defaults.items.map((d, i) => ({ key: i, d })));
  const err = (k: string) => (state && !state.ok && state.fieldErrors?.[k]) || undefined;
  const d = props.defaults;
  const f = (k: string) => `${scope}-${k}`;
  return (
    <form action={act} className="flex flex-col gap-4">
      {props.contractId ? <input type="hidden" name="contractId" value={props.contractId} /> : null}
      {props.quoteId ? <input type="hidden" name="quoteId" value={props.quoteId} /> : null}
      <Result state={state} ok={t("form.saved")} />
      {props.mode !== "revise" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("form.title")} htmlFor={f("title")} error={err("title")}>
            <Input id={f("title")} name="title" required minLength={3} maxLength={120} defaultValue={d.title} />
          </Field>
          {props.mode === "create" && !props.quoteId ? (
            <Field label={t("form.supplier")} htmlFor={f("seller")} hint={props.suppliers?.length ? undefined : t("form.supplierNone")} error={err("sellerBusinessId")}>
              <Select id={f("seller")} name="sellerBusinessId" required defaultValue={props.supplierId ?? ""}>
                <option value="">{t("form.supplierChoose")}</option>
                {props.suppliers?.map((s) => <option key={s.businessId} value={s.businessId}>{s.name}</option>)}
              </Select>
            </Field>
          ) : null}
        </div>
      ) : (
        <Field label={t("form.changeNote")} htmlFor={f("change")} hint={t("form.changeNoteHint")} error={err("changeNote")}>
          <Input id={f("change")} name="changeNote" maxLength={500} />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("form.validFrom")} htmlFor={f("from")} error={err("validFrom")}>
          <Input id={f("from")} name="validFrom" type="date" required defaultValue={d.validFrom} />
        </Field>
        <Field label={t("form.validTo")} htmlFor={f("to")} error={err("validTo")}>
          <Input id={f("to")} name="validTo" type="date" required min={props.today} defaultValue={d.validTo} />
        </Field>
        <Field label={t("form.terms")} htmlFor={f("terms")} hint={t("form.termsHint")} error={err("paymentTermsDays")}>
          <Input id={f("terms")} name="paymentTermsDays" type="number" inputMode="numeric" min={0} max={180} step={1} required defaultValue={d.paymentTermsDays} />
        </Field>
        <Field label={t("form.basis")} htmlFor={f("basis")} error={err("priceBasis")}>
          <Select id={f("basis")} name="priceBasis" defaultValue={d.priceBasis}>
            {BASES.map((b) => <option key={b} value={b}>{t(`basis.${b}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("form.valueCap")} htmlFor={f("vcap")} hint={t("form.valueCapHint")} error={err("valueCapPaise")}>
          <Input id={f("vcap")} name="valueCap" type="number" inputMode="decimal" min={1} step={0.01} defaultValue={d.valueCap} />
        </Field>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-ink">{t("form.itemsTitle")}</h3>
        {err("items") ? <Alert tone="danger">{err("items")}</Alert> : null}
        {rows.map((r, i) => (
          <ItemRow key={r.key} n={r.key} d={r.d} scope={scope} canRemove={rows.length > 1} onRemove={() => setRows((x) => x.filter((y) => y.key !== r.key))} />
        ))}
        <div>
          <Button type="button" variant="outline" onClick={() => setRows((x) => [...x, { key: next.current++, d: EMPTY_ITEM }])}>{t("form.addItem")}</Button>
        </div>
      </div>
      <Field label={t("form.notes")} htmlFor={f("notes")} error={err("notes")}>
        <Textarea id={f("notes")} name="notes" maxLength={2000} defaultValue={d.notes} />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? t("form.pending") : props.mode === "create" ? t("form.create") : props.mode === "draft" ? t("form.saveDraft") : t("form.propose")}
        </Button>
      </div>
    </form>
  );
}

/** Buyer sends the draft to the supplier. */
export function SendForm({ contractId }: { contractId: string }) {
  const t = useTranslations("contracts");
  const [state, act, pending] = useActionState<State, FormData>(sendAction, null);
  return (
    <form action={act} className="flex flex-col gap-2">
      <input type="hidden" name="contractId" value={contractId} />
      <Result state={state} />
      <div><Button type="submit" disabled={pending}>{pending ? t("send.pending") : t("send.submit")}</Button></div>
    </form>
  );
}

/** Accept or decline the pending revision. */
export function RespondForm({ contractId, revision }: { contractId: string; revision: number }) {
  const t = useTranslations("contracts");
  const [state, act, pending] = useActionState<State, FormData>(respondAction, null);
  const id = useId().replace(/:/g, "");
  const err = (state && !state.ok && state.fieldErrors?.reason) || undefined;
  return (
    <form action={act} className="flex flex-col gap-3">
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="revision" value={revision} />
      <Result state={state} />
      <Field label={t("respond.reason")} htmlFor={`${id}-reason`} hint={t("respond.reasonHint")} error={err}>
        <Input id={`${id}-reason`} name="reason" maxLength={500} />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="decision" value="accepted" disabled={pending}>{t("respond.accept")}</Button>
        <Button type="submit" name="decision" value="rejected" variant="outline" disabled={pending}>{t("respond.decline")}</Button>
      </div>
    </form>
  );
}

export function TerminateForm({ contractId }: { contractId: string }) {
  const t = useTranslations("contracts");
  const [state, act, pending] = useActionState<State, FormData>(terminateAction, null);
  const id = useId().replace(/:/g, "");
  return (
    <form action={act} className="flex flex-col gap-3">
      <input type="hidden" name="contractId" value={contractId} />
      <p className="text-sm text-muted">{t("terminate.note")}</p>
      <Result state={state} />
      <Field label={t("terminate.reason")} htmlFor={`${id}-reason`} error={state && !state.ok ? state.fieldErrors?.reason : undefined}>
        <Input id={`${id}-reason`} name="reason" required minLength={3} maxLength={300} />
      </Field>
      <div><Button type="submit" variant="outline" disabled={pending}>{t("terminate.submit")}</Button></div>
    </form>
  );
}

export function RenewForm({ contractId }: { contractId: string }) {
  const t = useTranslations("contracts");
  const [state, act, pending] = useActionState<State, FormData>(renewAction, null);
  return (
    <form action={act} className="flex flex-col gap-2">
      <input type="hidden" name="contractId" value={contractId} />
      <p className="text-sm text-muted">{t("renew.note")}</p>
      <Result state={state} />
      <div><Button type="submit" variant="outline" disabled={pending}>{pending ? t("renew.pending") : t("renew.submit")}</Button></div>
    </form>
  );
}

export interface CallOffItem {
  itemKey: string;
  description: string;
  unit: string;
  priceLabel: string;
  unitPricePaise: number;
  moq: number | null;
  remaining: number | null;
  indexed: { minPaise: number; maxPaise: number; capLabel: string } | null;
}

export interface AddressOption { id: string; label: string; summary: string; isDefault: boolean }

/** Pick quantities per item from the contract; prices come from the contract (an indexed item may be priced inside its band). */
export function CallOffForm(props: {
  contractId: string;
  items: CallOffItem[];
  addresses: AddressOption[];
  needsAddress: boolean;
  today: string;
  /** a fresh key per page load, so a double click or a retry never orders twice */
  idempotencyKey: string;
}) {
  const t = useTranslations("contracts");
  const [state, act, pending] = useActionState<State, FormData>(callOffAction, null);
  const id = useId().replace(/:/g, "");
  const err = (k: string) => (state && !state.ok && state.fieldErrors?.[k]) || undefined;
  return (
    <form action={act} className="flex flex-col gap-4">
      <input type="hidden" name="contractId" value={props.contractId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Result state={state} />
      {err("lines") ? <Alert tone="danger">{err("lines")}</Alert> : null}
      <div className="flex flex-col gap-3">
        {props.items.map((it, n) => (
          <fieldset key={it.itemKey} className="flex flex-col gap-3 rounded-lg border border-line p-3">
            <legend className="px-1 text-sm font-semibold text-ink">{it.description}</legend>
            <input type="hidden" name={`lines.${n}.itemKey`} value={it.itemKey} />
            <p className="text-sm text-muted">
              {t("calloff.price", { price: it.priceLabel, unit: it.unit })}
              {it.moq ? ` · ${t("calloff.moq", { moq: it.moq, unit: it.unit })}` : ""}
              {it.remaining !== null ? ` · ${t("calloff.remaining", { qty: it.remaining, unit: it.unit })}` : ""}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("calloff.quantity", { unit: it.unit })} htmlFor={`${id}-q${n}`}>
                <Input id={`${id}-q${n}`} name={`lines.${n}.quantity`} type="number" inputMode="numeric" min={it.moq ?? 1} max={it.remaining ?? undefined} step={1} />
              </Field>
              {it.indexed ? (
                <Field label={t("calloff.indexedPrice")} htmlFor={`${id}-p${n}`} hint={t("calloff.indexedHint", { cap: it.indexed.capLabel })}>
                  <Input id={`${id}-p${n}`} name={`lines.${n}.price`} type="number" inputMode="decimal" step={0.01} min={it.indexed.minPaise / 100} max={it.indexed.maxPaise / 100} defaultValue={it.unitPricePaise / 100} />
                </Field>
              ) : null}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {props.needsAddress ? (
          <Field label={t("calloff.address")} htmlFor={`${id}-addr`} error={err("addressId")}>
            <Select id={`${id}-addr`} name="addressId" required defaultValue={props.addresses.find((a) => a.isDefault)?.id ?? props.addresses[0]?.id}>
              {props.addresses.map((a) => <option key={a.id} value={a.id}>{a.label}: {a.summary}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label={t("calloff.delivery")} htmlFor={`${id}-del`} error={err("expectedDelivery")}>
          <Input id={`${id}-del`} name="expectedDelivery" type="date" min={props.today} />
        </Field>
      </div>
      <Field label={t("calloff.notes")} htmlFor={`${id}-notes`}>
        <Textarea id={`${id}-notes`} name="notes" maxLength={1000} />
      </Field>
      <p className="text-sm text-muted">{t("calloff.note")}</p>
      <div><Button type="submit" disabled={pending}>{pending ? t("calloff.pending") : t("calloff.submit")}</Button></div>
    </form>
  );
}
