import type { getTranslations } from "next-intl/server";
import { localizePath, type Locale } from "@/i18n/config";
import { breadcrumbLd } from "@/lib/schema";
import { absoluteUrl } from "@/lib/site-url";
import type { TopicId } from "./articles";

type Tr = Awaited<ReturnType<typeof getTranslations>>;

export interface Crumb {
  label: string;
  /** Unprefixed path; the current page (last crumb) has none. */
  href?: string;
}

/** Visible breadcrumb trail plus its schema.org BreadcrumbList (same items, absolute localised URLs, current page last). */
export function helpCrumbs(t: Tr, locale: Locale, topic?: { id: TopicId; title: string }, article?: { id: string; title: string }): { items: Crumb[]; ld: Record<string, unknown> } {
  const items: Crumb[] = [{ label: t("home"), href: "/" }];
  const trail: { label: string; path: string }[] = [{ label: t("helpCentre"), path: "/help" }];
  if (topic) trail.push({ label: topic.title, path: `/help/${topic.id}` });
  if (topic && article) trail.push({ label: article.title, path: `/help/${topic.id}/${article.id}` });
  trail.forEach((c, i) => items.push({ label: c.label, href: i < trail.length - 1 ? c.path : undefined }));
  const ld = breadcrumbLd([{ name: t("home"), path: localizePath("/", locale) }, ...trail.map((c) => ({ name: c.label, path: localizePath(c.path, locale) }))]);
  return { items, ld };
}

export const helpUrl = (path: string, locale: Locale) => absoluteUrl(localizePath(path, locale));
