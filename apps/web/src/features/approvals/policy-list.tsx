"use client";
import { Button } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PolicyForm, type PolicyFormValue } from "./forms";

type Members = { personId: string; label: string }[];

/** "Edit" disclosure for one existing rule: the form replaces the button while open and returns focus-safe on save/cancel. */
export function EditablePolicy({ members, initial }: { members: Members; initial: PolicyFormValue }) {
  const t = useTranslations("approvals");
  const [open, setOpen] = useState(false);
  if (open) return <div className="mt-3"><PolicyForm members={members} initial={initial} onDone={() => setOpen(false)} /></div>;
  return <div className="mt-3"><Button type="button" variant="outline" size="sm" aria-expanded={false} onClick={() => setOpen(true)} aria-label={`${t("rules.edit")}: ${initial.name}`}>{t("rules.edit")}</Button></div>;
}

export function NewPolicy({ members }: { members: Members }) {
  const t = useTranslations("approvals");
  const [open, setOpen] = useState(false);
  if (open) return <PolicyForm members={members} onDone={() => setOpen(false)} />;
  return <div><Button type="button" aria-expanded={false} onClick={() => setOpen(true)}>{t("rules.add")}</Button></div>;
}
