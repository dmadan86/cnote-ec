// Real order sink (ADR-017): ONDC orders become platform Orders (enquiry owns them), booked to the "ondc" system buyer
// business so every order event keeps its shape. Composition roots (api, worker, seller app) call wireOndcOrderSink().
import { confirmOrder, recordExternalOrder, transitionOrder } from "@cnote/enquiry";
import { ensureSystemBuyerBusiness } from "@cnote/identity";
import { setOrderSink, type OrderSink } from "./sink";

// The seller acts through the ONDC inbox; order functions check the business only, so a system person id is enough.
const sellerActor = (businessId: string) => ({ personId: "00000000-0000-0000-0000-000000000000", businessId });

export const enquiryOrderSink: OrderSink = {
  async recordExternalOrder(input) {
    const buyer = await ensureSystemBuyerBusiness("ondc", "ONDC network buyer");
    const { orderId } = await recordExternalOrder(input, buyer);
    return { orderId };
  },
  async onAccepted(orderId, sellerBusinessId) {
    await confirmOrder(sellerActor(sellerBusinessId), orderId);
  },
  async onRejected(orderId, sellerBusinessId) {
    await transitionOrder(sellerActor(sellerBusinessId), orderId, "cancelled");
  },
};

let wired = false;
export function wireOndcOrderSink(): void {
  if (wired) return;
  setOrderSink(enquiryOrderSink);
  wired = true;
}
