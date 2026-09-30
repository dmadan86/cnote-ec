"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert } from "@cnote/ui";
import { SubmitButton } from "@/features/shell/form-bits";
import { archiveListingAction, publishListingAction, type RowResult } from "./actions";

export function ListingRowActions({ id, canPublish, canArchive }: { id: string; canPublish: boolean; canArchive: boolean }) {
  const t = useTranslations("listings.rowActions");
  const [pub, publish] = useActionState<RowResult | null, FormData>(publishListingAction, null);
  const [arc, archive] = useActionState<RowResult | null, FormData>(archiveListingAction, null);
  const err = (pub && !pub.ok && pub.error) || (arc && !arc.ok && arc.error) || null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {canPublish ? (
          <form action={publish}>
            <input type="hidden" name="id" value={id} />
            <SubmitButton size="sm" pendingText={t("submitting")}>{t("submit")}</SubmitButton>
          </form>
        ) : null}
        {canArchive ? (
          <form action={archive}>
            <input type="hidden" name="id" value={id} />
            <SubmitButton size="sm" variant="outline" pendingText={t("archiving")}>{t("archive")}</SubmitButton>
          </form>
        ) : null}
      </div>
      {err ? <Alert tone="danger">{err}</Alert> : null}
    </div>
  );
}
