"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Badge, Button, Field, Input } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { deleteAddressAction, saveAddressAction, setDefaultAddressAction, verifyBuyerGstinAction } from "./actions";
import { stateLabel } from "@/features/identity/states";

type State = ActionResult | null;
const fe = (s: { ok: boolean; fieldErrors?: Record<string, string> } | null, k: string) => (s && !s.ok ? s.fieldErrors?.[k] : undefined);

export function GstinForm({ gstin, verified }: { gstin: string | null; verified: boolean }) {
  const t = useTranslations("account2");
  const ts = useTranslations("states");
  const [state, action, pending] = useActionState(verifyBuyerGstinAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state?.ok ? (
        <Alert tone="success">{t("gstinSuccess", { name: state.data.legalName, state: stateLabel(state.data.state, (c) => (ts.has(c) ? ts(c) : undefined)) })}</Alert>
      ) : state && !state.fieldErrors ? (
        <Alert tone="danger">{state.error}</Alert>
      ) : null}
      <Field label={t("gstinLabel")} htmlFor="gstin" hint={t("gstinHint")} error={fe(state, "gstin")}>
        <Input id="gstin" name="gstin" defaultValue={gstin ?? ""} maxLength={15} autoCapitalize="characters" autoComplete="off" spellCheck={false} required />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>{pending ? t("verifying") : verified ? t("reverify") : t("verify")}</Button>
      </div>
    </form>
  );
}

export interface AddressView {
  id: string;
  label: string;
  contactName: string | null;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

function AddressForm({ address, onDone }: { address?: AddressView; onDone: () => void }) {
  const t = useTranslations("account2");
  const [state, action, pending] = useActionState<State, FormData>(async (prev, fd) => {
    const r = await saveAddressAction(prev, fd);
    if (r.ok) onDone();
    return r;
  }, null);
  const id = address?.id ?? "new";
  return (
    <form action={action} className="flex flex-col gap-4 rounded-lg border border-line p-4" noValidate aria-label={address ? t("editFormTitle") : t("addFormTitle")}>
      <h3 className="text-sm font-semibold text-ink">{address ? t("editFormTitle") : t("addFormTitle")}</h3>
      {state && !state.ok && !state.fieldErrors ? <Alert tone="danger">{state.error}</Alert> : null}
      {address ? <input type="hidden" name="id" value={address.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("label")} htmlFor={`${id}-label`} hint={t("labelHint")} error={fe(state, "label")}>
          <Input id={`${id}-label`} name="label" defaultValue={address?.label ?? ""} maxLength={40} required />
        </Field>
        <Field label={t("contactName")} htmlFor={`${id}-contactName`} error={fe(state, "contactName")}>
          <Input id={`${id}-contactName`} name="contactName" defaultValue={address?.contactName ?? ""} autoComplete="name" />
        </Field>
        <Field label={t("phone")} htmlFor={`${id}-phone`} error={fe(state, "phone")}>
          <Input id={`${id}-phone`} name="phone" type="tel" inputMode="tel" defaultValue={address?.phone ?? ""} autoComplete="tel" />
        </Field>
      </div>
      <Field label={t("line1")} htmlFor={`${id}-line1`} error={fe(state, "line1")}>
        <Input id={`${id}-line1`} name="line1" defaultValue={address?.line1 ?? ""} autoComplete="address-line1" required />
      </Field>
      <Field label={t("line2")} htmlFor={`${id}-line2`} error={fe(state, "line2")}>
        <Input id={`${id}-line2`} name="line2" defaultValue={address?.line2 ?? ""} autoComplete="address-line2" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("city")} htmlFor={`${id}-city`} error={fe(state, "city")}>
          <Input id={`${id}-city`} name="city" defaultValue={address?.city ?? ""} autoComplete="address-level2" required />
        </Field>
        <Field label={t("pincode")} htmlFor={`${id}-pincode`} hint={t("stateFromPincode")} error={fe(state, "pincode")}>
          <Input id={`${id}-pincode`} name="pincode" defaultValue={address?.pincode ?? ""} inputMode="numeric" maxLength={6} autoComplete="postal-code" required />
        </Field>
      </div>
      {address?.isDefault ? null : (
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="makeDefault" className="size-5" /> {t("makeDefault")}
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>{pending ? t("saving") : t("saveAddress")}</Button>
        <Button type="button" variant="outline" onClick={onDone}>{t("cancel")}</Button>
      </div>
    </form>
  );
}

function AddressRow({ a }: { a: AddressView }) {
  const t = useTranslations("account2");
  const ts = useTranslations("states");
  const [editing, setEditing] = useState(false);
  if (editing) return <li><AddressForm address={a} onDone={() => setEditing(false)} /></li>;
  const stateText = stateLabel(a.state, (c) => (ts.has(c) ? ts(c) : undefined));
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-ink">{a.label}</p>
        {a.isDefault ? <Badge tone="brand">{t("defaultBadge")}</Badge> : null}
      </div>
      <p className="text-sm text-ink">
        {[a.line1, a.line2].filter(Boolean).join(", ")}
        <br />
        {t("cityStatePin", { city: a.city, state: stateText, pincode: a.pincode })}
      </p>
      {a.contactName || a.phone ? <p className="text-sm text-muted">{[a.contactName, a.phone].filter(Boolean).join(" · ")}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setEditing(true)} aria-label={t("editAria", { label: a.label })}>{t("edit")}</Button>
        {a.isDefault ? null : (
          <form action={setDefaultAddressAction}>
            <input type="hidden" name="id" value={a.id} />
            <Button type="submit" variant="outline" size="sm" className="min-h-11" aria-label={t("makeDefaultAria", { label: a.label })}>{t("makeDefaultShort")}</Button>
          </form>
        )}
        <form action={deleteAddressAction}>
          <input type="hidden" name="id" value={a.id} />
          <Button type="submit" variant="outline" size="sm" className="min-h-11" aria-label={t("deleteAria", { label: a.label })}>{t("delete")}</Button>
        </form>
      </div>
    </li>
  );
}

export function AddressManager({ addresses }: { addresses: AddressView[] }) {
  const t = useTranslations("account2");
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {addresses.length === 0 && !adding ? <p className="text-sm text-muted">{t("noAddresses")}</p> : null}
      {addresses.length ? <ul className="flex flex-col gap-3">{addresses.map((a) => <AddressRow key={a.id} a={a} />)}</ul> : null}
      {adding ? <AddressForm onDone={() => setAdding(false)} /> : <div><Button type="button" variant="outline" onClick={() => setAdding(true)}>{t("addAddress")}</Button></div>}
    </div>
  );
}
