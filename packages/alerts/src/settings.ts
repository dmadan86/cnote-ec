// Per-person alert opt-ins (all default OFF). The notification preferences (category "alerts") still decide the channel.
import { DomainError } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { verifyUnsubscribeToken } from "./token";
import type { AlertSettingsView, AlertType } from "./types";

const FIELD = { price_drop: "priceDrop", back_in_stock: "backInStock", followed_digest: "followedDigest" } as const;
type SettingType = keyof typeof FIELD;
const isSetting = (t: AlertType): t is SettingType => t in FIELD;

const view = (r: { priceDrop: boolean; backInStock: boolean; followedDigest: boolean } | null): AlertSettingsView =>
  ({ priceDrop: r?.priceDrop ?? false, backInStock: r?.backInStock ?? false, followedDigest: r?.followedDigest ?? false });

export async function getAlertSettings(personId: string): Promise<AlertSettingsView> {
  return view(await prisma.alertSettings.findUnique({ where: { personId } }));
}

/** Opt in or out of one alert type. Turning the followed digest on starts its window now (no backlog blast). */
export async function setAlertSetting(personId: string, type: Exclude<AlertType, "saved_search">, enabled: boolean): Promise<AlertSettingsView> {
  if (!isSetting(type)) throw new DomainError("validation", "Unknown alert type");
  const field = FIELD[type];
  const startWindow = type === "followed_digest" && enabled ? { followedDigestAt: new Date() } : {};
  const row = await prisma.alertSettings.upsert({
    where: { personId },
    create: { personId, [field]: enabled, ...startWindow },
    update: { [field]: enabled, ...startWindow },
  });
  return view(row);
}

/**
 * One-click unsubscribe from an email link. Idempotent. `saved_search` switches every saved search of the person to "off"
 * (the searches themselves are kept). Returns the type that was switched off, or null for an invalid token.
 */
export async function unsubscribeByToken(token: string): Promise<AlertType | null> {
  const v = verifyUnsubscribeToken(token);
  if (!v) return null;
  if (v.type === "saved_search") await prisma.savedSearch.updateMany({ where: { personId: v.personId, frequency: { not: "off" } }, data: { frequency: "off" } });
  else await prisma.alertSettings.upsert({ where: { personId: v.personId }, create: { personId: v.personId, [FIELD[v.type]]: false }, update: { [FIELD[v.type]]: false } });
  return v.type;
}

/** Who has this alert type switched on, among `personIds` (used by event handlers so non-opted-in people are never touched). */
export async function filterOptedIn(personIds: string[], type: "price_drop" | "back_in_stock"): Promise<Set<string>> {
  if (!personIds.length) return new Set();
  const rows = await prisma.alertSettings.findMany({ where: { personId: { in: personIds }, [FIELD[type]]: true }, select: { personId: true } });
  return new Set(rows.map((r) => r.personId));
}

/** Claims a dedupe key inside the caller's transaction: true the first time, false on a redelivery / re-run. */
export async function claimDispatch(tx: Tx, personId: string, dedupeKey: string, type: AlertType): Promise<boolean> {
  const { count } = await tx.alertDispatch.createMany({ data: [{ personId, dedupeKey, type }], skipDuplicates: true });
  return count === 1;
}
