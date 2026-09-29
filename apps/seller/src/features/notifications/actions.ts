"use server";
import { getConsents } from "@cnote/identity";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { channelLock, markRead, setPreference, type NotificationCategory } from "@cnote/notifications";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSeller } from "@/lib/auth";

const APP = "seller" as const;
const INBOX = "/notifications";
const PREFS = "/notifications/preferences";
const CATEGORIES: NotificationCategory[] = ["leads", "messages", "reviews", "listings", "billing", "security", "marketing"];
const CHANNELS = ["in_app", "email"] as const;

export async function markReadAction(fd: FormData): Promise<void> {
  const s = await requireSeller("/notifications");
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return;
  await markRead(s.personId, [id.data], APP);
  revalidatePath(INBOX);
}

export async function markAllReadAction(): Promise<void> {
  const s = await requireSeller("/notifications");
  await markRead(s.personId, "all", APP);
  revalidatePath(INBOX);
}

/** Saves every toggle in the form. Locked toggles (security, marketing without consent) are never written. */
export async function savePreferencesAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSeller("/notifications/preferences");
  const result = await runAction(async () => {
    const consents = await getConsents(s.personId);
    for (const category of CATEGORIES) {
      for (const channel of CHANNELS) {
        const lock = channelLock(category, channel);
        if (lock === "required" || (lock === "consent" && !consents.marketing)) continue;
        await setPreference(s.personId, category, channel, fd.get(`${category}:${channel}`) === "on");
      }
    }
  });
  if (result.ok) revalidatePath(PREFS);
  return result;
}
