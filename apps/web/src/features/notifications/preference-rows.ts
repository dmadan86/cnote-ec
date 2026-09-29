import "server-only";
import { getConsents } from "@cnote/identity";
import { CATEGORY_META, CHANNEL_LABEL, channelLock, getPreferences, type NotificationCategory } from "@cnote/notifications";

export interface PreferenceRow {
  category: NotificationCategory;
  label: string;
  description: string;
  channels: { channel: "in_app" | "email"; label: string; enabled: boolean; locked: null | "required" | "consent" }[];
}

const CATEGORIES: NotificationCategory[] = ["leads", "messages", "reviews", "security", "marketing"];

/** View model for the preferences form: stored prefs merged with defaults, plus why a toggle is locked. */
export async function loadPreferenceRows(personId: string): Promise<{ rows: PreferenceRow[]; marketingConsent: boolean }> {
  const [prefs, consents] = await Promise.all([getPreferences(personId), getConsents(personId)]);
  const rows = CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_META[category].label,
    description: CATEGORY_META[category].description,
    channels: (["in_app", "email"] as const).map((channel) => {
      const lock = channelLock(category, channel);
      const locked = lock === "consent" && consents.marketing ? null : lock;
      const enabled = category === "security" ? true : lock === "consent" && !consents.marketing ? false : prefs[category][channel];
      return { channel, label: CHANNEL_LABEL[channel], enabled, locked };
    }),
  }));
  return { rows, marketingConsent: consents.marketing };
}
