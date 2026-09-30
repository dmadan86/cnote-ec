"use server";
import { recordReachabilityResponse } from "@cnote/enquiry";
import { redirect } from "next/navigation";

/** POST-only confirmation (a server action is always a POST), so link prefetchers/scanners issuing GETs never confirm. */
export async function confirmReachabilityAction(fd: FormData): Promise<void> {
  const token = String(fd.get("token") ?? "");
  const lang = fd.get("lang") === "hi" ? "hi" : "en";
  const outcome = await recordReachabilityResponse(token);
  redirect(`/r/${encodeURIComponent(token)}?s=${outcome}&l=${lang}`);
}
