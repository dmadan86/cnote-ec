"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { LANGUAGES } from "@/lib/constants";
import { str } from "@/lib/form-data";
import { run } from "@/lib/run";
import { identity } from "@/lib/services";

export type SettingsResult = ActionResult<null>;

export async function updateProfileAction(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  const session = await requireSeller("/settings");
  return run(async () => {
    const input = z
      .object({
        name: z.string().min(2, "Enter your name.").max(80),
        preferredLanguage: z.enum(LANGUAGES.map((l) => l.code) as [string, ...string[]], "Choose a language."),
      })
      .parse({ name: str(fd, "name"), preferredLanguage: str(fd, "preferredLanguage") });
    await identity.updateProfile(session.personId, input);
    revalidatePath("/settings");
    return null;
  });
}

/** ADR-010: purpose-scoped consent, appended to the ledger, revocable here at any time. */
export async function updateConsentsAction(_prev: SettingsResult | null, fd: FormData): Promise<SettingsResult> {
  const session = await requireSeller("/settings");
  return run(async () => {
    for (const purpose of ["matching", "counterparty_sharing", "marketing"] as const) {
      await identity.setConsent(session.personId, purpose, fd.get(purpose) === "on", "seller_settings");
    }
    revalidatePath("/settings");
    return null;
  });
}

export async function signOutEverywhereAction(): Promise<void> {
  const session = await requireSeller("/settings");
  await identity.signOutAllSessions(session.personId, "seller");
  redirect("/signin");
}
