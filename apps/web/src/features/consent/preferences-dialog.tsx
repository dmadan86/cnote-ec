"use client";

import { PreferencesDialog as KitDialog } from "@cnote/next-kit/consent";
import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { SITE_NAME } from "@/features/shell/site";
import { ConsentRecord } from "./consent-record";
import { STORAGE_REGISTRY } from "./registry";

/** Second layer: the shared dialog bound to the buyer web's registry, site name and consent-record download. */
export function PreferencesDialog(props: Omit<ComponentProps<typeof KitDialog>, "registry" | "siteName" | "note" | "record">) {
  const t = useTranslations("consent");
  return <KitDialog registry={STORAGE_REGISTRY} siteName={SITE_NAME} note={t("embedsNote")} record={<ConsentRecord className="mt-4 border-t border-line pt-4" />} {...props} />;
}
