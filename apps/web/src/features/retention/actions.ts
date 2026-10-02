"use server";
// Buyer retention server actions (follows, saved searches, alert settings, unsubscribe). Each re-checks the session: server
// actions are reachable by direct POST. None of this touches ranking (docs/design/buyer-retention.md).
import { createSavedSearch, deleteSavedSearch, followSupplier, isFollowing, setAlertSetting, setSearchFrequency, unfollowSupplier, unsubscribeByToken, SEARCH_FREQUENCIES, type AlertType, type SearchFrequency } from "@cnote/alerts";
import { DomainError } from "@cnote/core";
import { currentSession, requireSession, type ActionResult } from "@cnote/next-kit";
import { getPreferences, setPreference } from "@cnote/notifications";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { runLocalized } from "@/i18n/errors";
import { getRequestLocale } from "@/lib/request-locale";
import { parseFiltersField } from "./search-url";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const freq = (v: string): SearchFrequency => ((SEARCH_FREQUENCIES as readonly string[]).includes(v) ? (v as SearchFrequency) : "off");

export type FollowResult = { ok: true; following: boolean } | { ok: false; error: string };

/** Follow / unfollow toggle for the supplier profile and seller card (the static page learns the state from GET /api/follow/<id>). */
export async function toggleFollowAction(businessId: string): Promise<FollowResult> {
  const s = await currentSession();
  if (!s) return { ok: false, error: (await getTranslations({ locale: await getRequestLocale(), namespace: "retention" }))("follow.signInToFollow") };
  const r = await runLocalized(async () => {
    if (await isFollowing(s.personId, businessId)) return (await unfollowSupplier(s.personId, businessId)).following;
    return (await followSupplier(s.personId, businessId)).following;
  });
  if (r.ok) {
    revalidatePath("/buyer/suppliers");
    return { ok: true, following: r.data };
  }
  return { ok: false, error: r.error };
}

/** An unfollow button on /buyer/suppliers (a plain form, so it works without JavaScript). */
export async function unfollowAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/buyer/suppliers");
  return runLocalized(async () => {
    await unfollowSupplier(s.personId, str(f, "businessId"));
    revalidatePath("/buyer/suppliers");
  });
}

/** Explicitly choosing daily/weekly is the opt-in; make sure at least one channel can actually deliver it. */
async function ensureAlertChannel(personId: string) {
  const prefs = (await getPreferences(personId)).alerts;
  if (!prefs.in_app && !prefs.email) await setPreference(personId, "alerts", "in_app", true);
}

export async function saveSearchAction(_prev: ActionResult<{ id: string }> | null, f: FormData): Promise<ActionResult<{ id: string }>> {
  const s = await requireSession("/search");
  return runLocalized(async () => {
    const frequency = freq(str(f, "frequency"));
    const saved = await createSavedSearch(s.personId, {
      query: str(f, "q"),
      filters: parseFiltersField(f.get("filters")),
      sort: str(f, "sort") || "relevance",
      name: str(f, "name") || undefined,
      frequency,
    });
    if (frequency !== "off") await ensureAlertChannel(s.personId);
    revalidatePath("/account/saved-searches");
    return { id: saved.id };
  });
}

export async function deleteSavedSearchAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/account/saved-searches");
  return runLocalized(async () => {
    await deleteSavedSearch(s.personId, str(f, "id"));
    revalidatePath("/account/saved-searches");
  });
}

export async function setSearchFrequencyAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/account/saved-searches");
  return runLocalized(async () => {
    const frequency = freq(str(f, "frequency"));
    await setSearchFrequency(s.personId, str(f, "id"), frequency);
    if (frequency !== "off") await ensureAlertChannel(s.personId);
    revalidatePath("/account/saved-searches");
  });
}

const TYPES = { priceDrop: "price_drop", backInStock: "back_in_stock", followedDigest: "followed_digest" } as const;

/** Saves the three per-type opt-ins and the in-app / email channel choice for alerts. Unchecked = off. */
export async function saveAlertSettingsAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/account/alerts");
  return runLocalized(async () => {
    for (const [field, type] of Object.entries(TYPES)) await setAlertSetting(s.personId, type, f.get(field) === "on");
    await setPreference(s.personId, "alerts", "in_app", f.get("channel:in_app") === "on");
    await setPreference(s.personId, "alerts", "email", f.get("channel:email") === "on");
    revalidatePath("/account/alerts");
    revalidatePath("/buyer/suppliers");
  });
}

/** One-click unsubscribe from an alert email (no session needed: the signed token is the credential). */
export async function unsubscribeAlertAction(_prev: ActionResult<{ type: AlertType }> | null, f: FormData): Promise<ActionResult<{ type: AlertType }>> {
  return runLocalized(async () => {
    const type = await unsubscribeByToken(str(f, "token"));
    if (!type) throw new DomainError("validation", "This unsubscribe link is not valid.");
    return { type };
  });
}
