// Thin barrel over the domain-module contracts, so pages import one place. Server-only.
import "server-only";
import * as billing from "@cnote/billing";
import * as catalogue from "@cnote/catalogue";
import * as enquiry from "@cnote/enquiry";
import * as identity from "@cnote/identity";
import { currentSession } from "@cnote/next-kit";
import type { Session } from "@cnote/identity";

export { billing, catalogue, enquiry, identity };

/** Public pages must not crash if auth infrastructure is down. */
export async function currentSessionSafe(): Promise<Session | null> {
  try {
    return await currentSession();
  } catch (err) {
    console.error("[seller] currentSession failed", err);
    return null;
  }
}
