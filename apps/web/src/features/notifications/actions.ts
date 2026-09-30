"use server";
import { getConsents } from "@cnote/identity";
import { type ActionResult } from "@cnote/next-kit";
import { runLocalized } from "@/i18n/errors";
import { channelLock, markRead, setPreference, type NotificationCategory } from "@cnote/notifications";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@cnote/next-kit";

const APP = "web" as const;
const INBOX = "/account/notifications";
const PREFS = "/account/notifications/preferences";
const CATEGORIES: NotificationCategory[] = ["leads", "messages", "reviews", "security", "marketing"];
const CHANNELS = ["in_app", "email"] as const;

export async function markReadAction(fd: FormData): Promise<void> {
  const s = await requireSession("/account/notifications");
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return;
  await markRead(s.personId, [id.data], APP);
  revalidatePath(INBOX);
}

export async function markAllReadAction(): Promise<void> {
  const s = await requireSession("/account/notifications");
  await markRead(s.personId, "all", APP);
  revalidatePath(INBOX);
}

/** Saves every toggle in the form. Locked toggles (security, marketing without consent) are never written. */
export async function savePreferencesAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account/notifications/preferences");
  const result = await runLocalized(async () => {
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
