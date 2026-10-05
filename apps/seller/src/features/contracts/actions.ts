"use server";
// Seller-side rate-contract actions (docs/design/rate-contracts.md). Sellers answer, counter-propose and end contracts; they never
// create contracts or place call-offs. Each action re-checks the session; the domain module re-checks ownership.
import { revalidatePath } from "next/cache";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import type { RcItemInput, RcTermsInput } from "@cnote/enquiry";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { run } from "@/lib/run";
import { enquiry } from "@/lib/services";

export type ContractResult = ActionResult<null>;

function refresh(id: string): void {
  revalidatePath(`/contracts/${id}`);
  revalidatePath("/contracts");
}

export async function respondContractAction(_prev: ContractResult | null, fd: FormData): Promise<ContractResult> {
  const id = str(fd, "contractId");
  const session = await requireSeller(`/contracts/${id}`);
  const decision = str(fd, "decision");
  return run(async () => {
    if (decision !== "accepted" && decision !== "rejected") throw new Error("invalid action");
    await enquiry.respondToRateContract(actorOf(session), id, { revision: Number(str(fd, "revision")), decision, reason: str(fd, "reason") || null });
    refresh(id);
    return null;
  });
}

export async function terminateContractAction(_prev: ContractResult | null, fd: FormData): Promise<ContractResult> {
  const id = str(fd, "contractId");
  const session = await requireSeller(`/contracts/${id}`);
  return run(async () => {
    await enquiry.terminateRateContract(actorOf(session), id, str(fd, "reason"));
    refresh(id);
    return null;
  });
}

const rupeesToPaise = (v: string): number => Math.round(Number(v) * 100);
const optInt = (v: string): number | null => (v === "" ? null : Number(v));

/** Reads the repeated item_<i>_* fields of the counter-proposal form. Rupee and percent inputs become paise and basis points. */
export async function proposeContractAction(_prev: ContractResult | null, fd: FormData): Promise<ContractResult> {
  const id = str(fd, "contractId");
  const session = await requireSeller(`/contracts/${id}`);
  return run(async () => {
    const count = Math.min(Number(str(fd, "itemCount")) || 0, 60);
    const items: RcItemInput[] = [];
    for (let i = 0; i < count; i++) {
      const f = (k: string) => str(fd, `item_${i}_${k}`);
      if (f("remove") === "yes" || (f("description") === "" && f("price") === "")) continue;
      const indexed = f("variation") === "indexed";
      items.push({
        itemKey: f("key") || null,
        listingId: f("listing") || null,
        hsn: f("hsn") || null,
        description: f("description"),
        unit: f("unit"),
        unitPricePaise: rupeesToPaise(f("price")),
        gstRateBps: Math.round(Number(f("gst")) * 100),
        moq: optInt(f("moq")),
        quantityCap: optInt(f("cap")),
        variationKind: indexed ? "indexed" : "fixed",
        variationCapBps: indexed ? Math.round(Number(f("varcap")) * 100) : null,
        variationNote: indexed ? f("varnote") : null,
      });
    }
    const cap = str(fd, "valueCap");
    const terms: RcTermsInput = {
      validFrom: str(fd, "validFrom"),
      validTo: str(fd, "validTo"),
      paymentTermsDays: Number(str(fd, "paymentTermsDays")),
      priceBasis: str(fd, "priceBasis") as RcTermsInput["priceBasis"],
      valueCapPaise: cap === "" ? null : rupeesToPaise(cap),
      notes: str(fd, "notes") || null,
      changeNote: str(fd, "changeNote") || null,
      items,
    };
    await enquiry.proposeRateContractRevision(actorOf(session), id, terms);
    refresh(id);
    return null;
  });
}
