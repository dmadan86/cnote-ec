"use server";
import { recordReachabilityResponse } from "@cnote/enquiry";
import { redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";

/** POST-only confirmation (a server action is always a POST), so link prefetchers/scanners issuing GETs never confirm. */
export async function confirmReachabilityAction(fd: FormData): Promise<void> {
  const token = String(fd.get("token") ?? "");
  const rawLang = fd.get("lang");
  const lang = isLocale(rawLang) ? rawLang : "en";
  const outcome = await recordReachabilityResponse(token);
  redirect(`/r/${encodeURIComponent(token)}?s=${outcome}&l=${lang}`);
}
