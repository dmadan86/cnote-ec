// Partner factory: ESCROW_PARTNER=mock|razorpay_route|cashfree (default mock).
import { DomainError } from "@cnote/core";
import { CashfreePartner, RazorpayRoutePartner } from "./adapters";
import { MockPartner } from "./mock";
import { isPartnerName, type EscrowPartner, type PartnerName } from "./types";

export * from "./types";
export { MockPartner, MOCK_SIGNATURE_HEADER, mockSign } from "./mock";
export { CashfreePartner, RazorpayRoutePartner } from "./adapters";

const instances = new Map<PartnerName, EscrowPartner>();
let override: EscrowPartner | null = null;

/** Tests / composition root: replace the partner (null restores the env-selected one). */
export function setEscrowPartner(p: EscrowPartner | null): void { override = p; }

export function configuredPartnerName(env: NodeJS.ProcessEnv = process.env): PartnerName {
  const v = env.ESCROW_PARTNER ?? "mock";
  if (!isPartnerName(v)) throw new DomainError("validation", `Unknown ESCROW_PARTNER "${v}".`);
  return v;
}

export function getEscrowPartner(name: PartnerName = override?.name ?? configuredPartnerName()): EscrowPartner {
  if (override && override.name === name) return override;
  let p = instances.get(name);
  if (!p) {
    p = name === "mock" ? new MockPartner() : name === "razorpay_route" ? new RazorpayRoutePartner() : new CashfreePartner();
    instances.set(name, p);
  }
  return p;
}
