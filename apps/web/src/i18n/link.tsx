"use client";
import Link from "next/link";
import { useLocale } from "next-intl";
import type { ComponentProps } from "react";
import { isLocale, localizePath } from "./config";

/** next/link that adds the locale prefix for non-default locales (string hrefs to localised pages only). */
export function LocaleLink({ href, ...rest }: ComponentProps<typeof Link>) {
  const l = useLocale();
  const locale = isLocale(l) ? l : "en";
  return <Link href={typeof href === "string" ? localizePath(href, locale) : href} {...rest} />;
}
