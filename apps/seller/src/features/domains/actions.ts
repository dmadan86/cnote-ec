"use server";
import type { ActionResult } from "@cnote/next-kit";
import { addDomain, removeDomain, requestRecheck, setPrimary } from "@cnote/domains";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { run } from "@/lib/run";

const PATH = "/storefront/domains";
const id = z.uuid();

export async function addDomainAction(_prev: ActionResult<null> | null, fd: FormData): Promise<ActionResult<null>> {
  const session = await requireSeller(PATH);
  const t = await getTranslations("storefront.form");
  return run(async () => {
    const hostname = z.string().trim().min(3, t("invalid")).max(253).parse(str(fd, "hostname"));
    await addDomain(session.business.id, hostname);
    revalidatePath(PATH);
    return null;
  });
}

export async function removeDomainAction(_prev: ActionResult<null> | null, fd: FormData): Promise<ActionResult<null>> {
  const session = await requireSeller(PATH);
  return run(async () => {
    await removeDomain(session.business.id, id.parse(str(fd, "id")));
    revalidatePath(PATH);
    return null;
  });
}

export async function setPrimaryAction(_prev: ActionResult<null> | null, fd: FormData): Promise<ActionResult<null>> {
  const session = await requireSeller(PATH);
  return run(async () => {
    await setPrimary(session.business.id, id.parse(str(fd, "id")));
    revalidatePath(PATH);
    return null;
  });
}

/** Rate limited (5 per 10 minutes per domain) inside the domains module. */
export async function recheckDomainAction(_prev: ActionResult<null> | null, fd: FormData): Promise<ActionResult<null>> {
  const session = await requireSeller(PATH);
  return run(async () => {
    await requestRecheck(session.business.id, id.parse(str(fd, "id")));
    revalidatePath(PATH);
    return null;
  });
}
