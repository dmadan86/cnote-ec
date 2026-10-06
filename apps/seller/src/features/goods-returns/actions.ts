"use server";
// Seller-side return actions (docs/design/grn-returns.md). Each re-checks the session: server actions are reachable by direct POST.
import { revalidatePath } from "next/cache";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { numOrNull, str } from "@/lib/form-data";
import { run } from "@/lib/run";
import { enquiry } from "@/lib/services";

export type ReturnResult = ActionResult<null>;

const toPaise = (v: number | null): number => (v === null || !Number.isFinite(v) || v < 0 ? -1 : Math.round(v * 100));

export async function decideReturnAction(_prev: ReturnResult | null, fd: FormData): Promise<ReturnResult> {
  const id = str(fd, "returnId");
  const session = await requireSeller(`/returns/${id}`);
  const decision = str(fd, "decision");
  return run(async () => {
    if (decision !== "approved" && decision !== "rejected") throw new Error("invalid action");
    await enquiry.decideReturn(actorOf(session), id, { decision, note: str(fd, "note") || null });
    revalidatePath("/returns", "layout");
    return null;
  });
}

export async function receiveReturnAction(_prev: ReturnResult | null, fd: FormData): Promise<ReturnResult> {
  const id = str(fd, "returnId");
  const session = await requireSeller(`/returns/${id}`);
  return run(async () => {
    await enquiry.confirmReturnReceived(actorOf(session), id);
    revalidatePath("/returns", "layout");
    return null;
  });
}

export async function creditNoteAction(_prev: ReturnResult | null, fd: FormData): Promise<ReturnResult> {
  const id = str(fd, "returnId");
  const session = await requireSeller(`/returns/${id}`);
  return run(async () => {
    await enquiry.recordReturnCreditNote(actorOf(session), id, {
      invoiceId: str(fd, "invoiceId"), number: str(fd, "number"), noteDate: str(fd, "noteDate"),
      taxablePaise: toPaise(numOrNull(fd, "taxable")), gstPaise: toPaise(numOrNull(fd, "gst")), irn: str(fd, "irn") || null,
    });
    revalidatePath("/returns", "layout");
    revalidatePath("/orders", "layout");
    return null;
  });
}
