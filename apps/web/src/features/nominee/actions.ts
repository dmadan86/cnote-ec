"use server";
// DPDP s.14 nominee (docs/compliance/dpdp-checklist.md). Add / change / revoke need step-up (password, MFA code or a fresh OTP, checked in
// @cnote/compliance); the public nominee request is rate-limited per client IP and answers identically whatever exists.
import { addNominee, changeNominee, fileNomineeRequest, NOMINEE_GROUNDS, revokeNominee, type NomineeInput } from "@cnote/compliance";
import { DomainError, rateLimit } from "@cnote/core";
import { requireSession, type ActionResult } from "@cnote/next-kit";
import { clientIp } from "@cnote/security/client-ip";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { runLocalized } from "@/i18n/errors";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const proofOf = (fd: FormData) => ({ password: str(fd, "password"), mfaCode: str(fd, "mfaCode") });
const nomineeOf = (fd: FormData) => ({ name: str(fd, "name"), relationship: str(fd, "relationship"), contact: str(fd, "contact") }) as NomineeInput;

export async function saveNomineeAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account/nominee");
  const id = str(fd, "id");
  const r = await runLocalized(() => (id ? changeNominee(s.personId, id, nomineeOf(fd), proofOf(fd)) : addNominee(s.personId, nomineeOf(fd), proofOf(fd))).then(() => undefined));
  if (r.ok) revalidatePath("/account/nominee");
  return r;
}

export async function revokeNomineeAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account/nominee");
  const r = await runLocalized(() => revokeNominee(s.personId, str(fd, "id"), proofOf(fd)));
  if (r.ok) revalidatePath("/account/nominee");
  return r;
}

export interface FiledNomineeRequest {
  id: string;
  days: number;
}

/** Public: a nominee asks to exercise a deceased or incapacitated person's rights. Same answer whether or not the account/nomination exists. */
export async function fileNomineeRequestAction(_prev: ActionResult<FiledNomineeRequest> | null, fd: FormData): Promise<ActionResult<FiledNomineeRequest>> {
  const ip = clientIp(await headers()) ?? "unknown";
  return runLocalized(async () => {
    if (!(await rateLimit(`nominee-request:${ip}`, 5, 3600))) throw new DomainError("rate_limited", "Too many requests. Please try again later.");
    const ground = str(fd, "ground");
    const filed = await fileNomineeRequest({
      principalEmail: str(fd, "principalEmail"),
      requesterName: str(fd, "requesterName"),
      requesterContact: str(fd, "requesterContact"),
      ground: (NOMINEE_GROUNDS as readonly string[]).includes(ground) ? (ground as (typeof NOMINEE_GROUNDS)[number]) : ("" as never),
      message: str(fd, "message"),
    });
    return { id: filed.id.slice(0, 8), days: Math.round((new Date(filed.dueAt).getTime() - Date.now()) / 86_400_000) };
  });
}
